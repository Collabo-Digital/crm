import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConversationStatus, InboxAvailability, MessageSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { MessagingSendService } from '../messaging/send/messaging-send.service';
import { PlatformSenderService } from '../messaging/send/platform-sender.service';
import { contactName } from '../messaging/contact-name';
import { interpolate, keywordMatches } from '../automation/engine/flow';
import { ASSIGNABLE_ROLES, presenceOf } from './inbox-team.service';
import { InboxSettings, RoutingRule, isOpen } from './inbox-settings.schema';
import { InboxSettingsService } from './inbox-settings.service';

/** The parts of an automation event the inbox rules read. */
export interface RuleEvent {
    id: string;
    organizationId: string;
    channelId: string | null;
    contactId: string | null;
    eventType: string;
    text: string | null;
    /** Set by ingest: this message started a new or reopened conversation. */
    newConversation: boolean;
}

const MESSAGE_EVENTS = new Set(['whatsapp.message', 'whatsapp.cart', 'instagram.message', 'facebook.message', 'instagram.postback', 'facebook.postback', 'instagram.mention']);
const CONVERSATION_EVENTS = new Set([...MESSAGE_EVENTS, 'instagram.comment', 'facebook.comment']);
const HOUR = 3600_000;

const conversationInclude = {
    contact: { select: { id: true, tags: true, displayName: true, username: true, addressBookName: true, phone: true, externalId: true, waId: true } },
    customer: { select: { firstName: true, tags: true } },
} satisfies Prisma.ConversationInclude;

type RuleConversation = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

/**
 * What the inbox does on its own when a conversation starts or a message
 * arrives: route it, greet or say "we're away", and handle spam. Runs from
 * the automation dispatcher, once per stored event.
 */
@Injectable()
export class InboxRulesService {
    private readonly logger = new Logger(InboxRulesService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly settings: InboxSettingsService,
        private readonly sender: MessagingSendService,
        private readonly platform: PlatformSenderService,
        private readonly events: InboxEventsService,
    ) { }

    /**
     * A message or comment came in. `automated` is true when an automation
     * took it (a waiting flow got its reply, or a trigger fired), in which
     * case the welcome and away messages stay quiet.
     */
    async onEvent(event: RuleEvent, opts: { automated: boolean }): Promise<void> {
        if (!CONVERSATION_EVENTS.has(event.eventType) || !event.channelId || !event.contactId) return;
        const conversation = await this.prisma.conversation.findUnique({
            where: { channelId_contactId: { channelId: event.channelId, contactId: event.contactId } },
            include: conversationInclude,
        });
        if (!conversation) return;
        const { settings, timeZone } = await this.settings.get(event.organizationId);

        if (event.newConversation && !conversation.assignedUserId) await this.route(conversation, event, settings);
        if (!opts.automated && MESSAGE_EVENTS.has(event.eventType)) await this.autoReply(conversation, event, settings, timeZone);
    }

    /** The spam tag closes the conversation and blocks the contact. */
    async onTagAdded(event: RuleEvent & { tag: string }): Promise<boolean> {
        if (!event.contactId) return false;
        const { settings } = await this.settings.get(event.organizationId);
        if (!settings.spam.enabled || event.tag.toLowerCase() !== settings.spam.tag.toLowerCase()) return false;

        const contact = await this.prisma.channelContact.findUnique({
            where: { id: event.contactId },
            select: { id: true, platform: true, channelId: true, waId: true, blockedAt: true },
        });
        if (!contact) return false;
        const now = new Date();
        const conversations = await this.prisma.conversation.findMany({ where: { contactId: contact.id }, select: { id: true, status: true } });
        await this.prisma.$transaction([
            this.prisma.channelContact.update({ where: { id: contact.id }, data: { blockedAt: contact.blockedAt ?? now } }),
            this.prisma.conversation.updateMany({
                where: { contactId: contact.id, status: { not: ConversationStatus.CLOSED } },
                data: { status: ConversationStatus.CLOSED, closedAt: now, snoozedUntil: null },
            }),
        ]);
        if (settings.spam.blockOnWhatsApp && contact.platform === 'WHATSAPP') {
            try {
                await this.platform.blockOnWhatsApp(contact.channelId, contact);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                this.logger.warn(`WhatsApp block for contact ${contact.id} failed: ${reason}`);
                const conversation = conversations[0];
                if (conversation) {
                    await this.prisma.conversationNote.create({
                        data: {
                            organizationId: event.organizationId,
                            conversationId: conversation.id,
                            source: 'inbox_rule',
                            body: `Marked as spam and blocked here. WhatsApp did not block the number: ${reason}`,
                        },
                    });
                }
            }
        }
        for (const c of conversations) this.events.publish(event.organizationId, { type: 'conversation.updated', conversationId: c.id });
        return true;
    }

    /**
     * Someone to take a new conversation: an online member (of the team, when
     * given) under their open-conversation cap, the one assigned longest ago
     * first. Null when nobody is available.
     */
    async pickAgent(orgId: string, teamId: string | null, maxOpenPerAgent: number): Promise<string | null> {
        const now = new Date();
        const members = await this.prisma.organizationMember.findMany({
            where: {
                organizationId: orgId,
                isActive: true,
                role: { in: ASSIGNABLE_ROLES },
                inboxStatus: InboxAvailability.ONLINE,
                ...(teamId ? { user: { inboxTeams: { some: { teamId } } } } : {}),
            },
            select: { userId: true, inboxStatus: true, inboxSeenAt: true, inboxLastAssignedAt: true },
        });
        const online = members.filter((m) => presenceOf(m.inboxStatus, m.inboxSeenAt, now) === 'online');
        if (!online.length) return null;
        const load = await this.prisma.conversation.groupBy({
            by: ['assignedUserId'],
            where: { organizationId: orgId, status: ConversationStatus.OPEN, assignedUserId: { in: online.map((m) => m.userId) } },
            _count: { _all: true },
        });
        const open = new Map(load.map((l) => [l.assignedUserId, l._count._all]));
        const pick = online
            .filter((m) => (open.get(m.userId) ?? 0) < maxOpenPerAgent)
            .sort((a, b) => (a.inboxLastAssignedAt?.getTime() ?? 0) - (b.inboxLastAssignedAt?.getTime() ?? 0))[0];
        if (!pick) return null;
        await this.prisma.organizationMember.update({
            where: { organizationId_userId: { organizationId: orgId, userId: pick.userId } },
            data: { inboxLastAssignedAt: now },
        });
        return pick.userId;
    }

    /** Close conversations nobody has written in for the configured time. Hourly. */
    @Cron(CronExpression.EVERY_HOUR)
    async autoClose(now = new Date()): Promise<number> {
        const orgs = await this.prisma.organizationSettings.findMany({
            where: { inboxSettings: { path: ['autoClose', 'enabled'], equals: true } },
            select: { organizationId: true },
        });
        let closed = 0;
        for (const { organizationId } of orgs) {
            const { settings } = await this.settings.get(organizationId);
            if (!settings.autoClose.enabled) continue;
            const before = new Date(now.getTime() - settings.autoClose.afterHours * HOUR);
            const stale = await this.prisma.conversation.findMany({
                where: { organizationId, status: ConversationStatus.OPEN, lastMessageAt: { lt: before } },
                select: { id: true },
                take: 1000,
            });
            if (!stale.length) continue;
            const { count } = await this.prisma.conversation.updateMany({
                where: { id: { in: stale.map((c) => c.id) }, status: ConversationStatus.OPEN, lastMessageAt: { lt: before } },
                data: { status: ConversationStatus.CLOSED, closedAt: now },
            });
            closed += count;
            for (const c of stale) this.events.publish(organizationId, { type: 'conversation.updated', conversationId: c.id });
        }
        if (closed) this.logger.log(`Auto-closed ${closed} inactive conversations`);
        return closed;
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    private async route(conversation: RuleConversation, event: RuleEvent, settings: InboxSettings) {
        const rule = settings.routing.rules.find((r) => this.ruleMatches(r, conversation, event));
        let assignedUserId: string | null = null;
        let teamId: string | null = null;
        if (rule) {
            if (rule.assign.mode === 'user') assignedUserId = (await this.activeMember(event.organizationId, rule.assign.userId)) ? rule.assign.userId : null;
            teamId = rule.assign.mode !== 'user' && rule.assign.teamId ? rule.assign.teamId : null;
            if (rule.assign.mode === 'round_robin') {
                assignedUserId = await this.pickAgent(event.organizationId, teamId, settings.roundRobin.maxOpenPerAgent);
            }
        } else if (settings.roundRobin.enabled) {
            teamId = settings.roundRobin.teamId || null;
            assignedUserId = await this.pickAgent(event.organizationId, teamId, settings.roundRobin.maxOpenPerAgent);
        }
        if (teamId && !(await this.prisma.inboxTeam.findFirst({ where: { id: teamId, organizationId: event.organizationId }, select: { id: true } }))) {
            teamId = null;
        }
        if (!assignedUserId && !teamId) return;
        await this.prisma.conversation.updateMany({
            where: { id: conversation.id, assignedUserId: null },
            data: { ...(assignedUserId ? { assignedUserId } : {}), ...(teamId ? { teamId } : {}) },
        });
        this.events.publish(event.organizationId, { type: 'conversation.updated', conversationId: conversation.id });
    }

    private ruleMatches(rule: RoutingRule, conversation: RuleConversation, event: RuleEvent): boolean {
        const test = (c: RoutingRule['conditions'][number]) => {
            const value = c.value.trim();
            switch (c.field) {
                case 'message':
                    return keywordMatches(event.text, value.split(',').map((v) => v.trim()).filter(Boolean), 'contains');
                case 'platform':
                    return conversation.platform === value.toUpperCase();
                case 'channel':
                    return conversation.channelId === value;
                case 'tag':
                    return conversation.contact.tags.some((t) => t.toLowerCase() === value.toLowerCase());
                case 'customer':
                    if (c.op === 'vip') return !!conversation.customer?.tags.some((t) => t.toLowerCase() === (value || 'vip').toLowerCase());
                    return !!conversation.customerId;
                default:
                    return false;
            }
        };
        return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test);
    }

    private async autoReply(conversation: RuleConversation, event: RuleEvent, settings: InboxSettings, timeZone: string) {
        const open = isOpen(settings.businessHours, timeZone);
        const kind = open ? (event.newConversation ? 'welcome' : null) : 'away';
        if (!kind) return;
        const reply = settings[kind];
        if (!reply.enabled || !reply.message.trim() || !reply.platforms.includes(conversation.platform as never)) return;

        const keyPrefix = `${kind}:${conversation.contactId}:`;
        const recent = await this.prisma.message.findFirst({
            where: {
                contactId: conversation.contactId,
                source: MessageSource.SYSTEM,
                idempotencyKey: { startsWith: keyPrefix },
                createdAt: { gte: new Date(Date.now() - reply.cooldownHours * HOUR) },
            },
            select: { id: true },
        });
        if (recent) return;

        const name = contactName(conversation.contact)?.replace(/^@/, '') ?? '';
        const first = conversation.customer?.firstName ?? (/\p{L}/u.test(name) ? name.split(/\s+/)[0] : null);
        const outcome = await this.sender.send({
            organizationId: event.organizationId,
            conversationId: conversation.id,
            origin: 'system',
            payload: { type: 'text', text: interpolate(reply.message, { first_name: first, name }) },
            idempotencyKey: `${keyPrefix}${event.id}`,
        });
        if (!outcome.ok) this.logger.warn(`${kind} message not sent in ${conversation.id}: ${outcome.message}`);
    }

    private activeMember(orgId: string, userId: string) {
        if (!userId) return null;
        return this.prisma.organizationMember.findFirst({
            where: { organizationId: orgId, userId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
            select: { userId: true },
        });
    }
}
