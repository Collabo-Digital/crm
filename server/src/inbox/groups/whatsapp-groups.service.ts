import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, ConversationStatus, Prisma, WhatsAppGroup, WhatsAppGroupStatus } from '@prisma/client';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { Priority } from '../../rate-limit/rate-limit.types';
import { ChannelAccessService } from '../../messaging/channel-access.service';
import { InboxEventsService } from '../../messaging/inbox-events.service';
import { IngestChannel, MessageIngestService } from '../../messaging/message-ingest.service';
import { whatsAppContent } from '../../messaging/message-content';
import type { WaGroupChange, WaGroupField, WaMessage } from '../../automation/platforms/whatsapp/whatsapp-webhook.parser';
import {
    GROUP_DESCRIPTION_MAX,
    GROUP_MAX_PARTICIPANTS,
    GROUP_SUBJECT_MAX,
    groupContactExternalId,
    groupErrorMessage,
    participantLabel,
} from './whatsapp-groups.util';

const GROUP_FIELDS = 'subject,description,participants,join_approval_mode,suspended,total_participant_count';

export interface CreateGroupInput {
    channelId: string;
    subject: string;
    description?: string;
    joinApprovalMode?: 'auto_approve' | 'approval_required';
}

/**
 * WhatsApp groups run from Collabo (Cloud API Groups): created and managed
 * here, kept current by the group webhooks, and chatted in from the inbox,
 * where each group is a conversation of its own contact. Meta's rules are in
 * whatsapp-groups.util.ts.
 */
@Injectable()
export class WhatsAppGroupsService {
    private readonly logger = new Logger(WhatsAppGroupsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly metaGraph: MetaGraphClient,
        private readonly access: ChannelAccessService,
        private readonly ingest: MessageIngestService,
        private readonly events: InboxEventsService,
    ) { }

    /** The organization's groups, and which of its WhatsApp numbers can run them. */
    async list(orgId: string) {
        const [groups, channels] = await Promise.all([
            this.prisma.whatsAppGroup.findMany({
                where: { organizationId: orgId, status: { not: WhatsAppGroupStatus.DELETED } },
                include: this.listInclude,
                orderBy: { createdAt: 'desc' },
            }),
            this.prisma.channel.findMany({
                where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
                select: { id: true, name: true, status: true, credentials: true },
                orderBy: { createdAt: 'asc' },
            }),
        ]);
        return {
            numbers: channels.map((c) => {
                const onBusinessApp = (c.credentials as { isOnBizApp?: boolean } | null)?.isOnBizApp === true;
                return {
                    channelId: c.id,
                    name: c.name,
                    available: c.status === ChannelStatus.CONNECTED && !onBusinessApp,
                    reason: onBusinessApp
                        ? 'This number is shared with the WhatsApp Business app; Meta does not allow groups on it.'
                        : c.status !== ChannelStatus.CONNECTED
                            ? 'Reconnect this number first.'
                            : null,
                };
            }),
            groups: groups.map((g) => this.view(g)),
        };
    }

    async get(orgId: string, id: string) {
        const group = await this.load(orgId, id);
        const [participants, joinRequests] = await Promise.all([
            this.prisma.whatsAppGroupParticipant.findMany({ where: { groupId: group.id, leftAt: null }, orderBy: { joinedAt: 'asc' } }),
            this.prisma.whatsAppGroupJoinRequest.findMany({ where: { groupId: group.id, status: 'PENDING' }, orderBy: { requestedAt: 'asc' } }),
        ]);
        return {
            ...this.view(group),
            participants: participants.map((p) => ({ waId: p.waId, name: p.name, joinedAt: p.joinedAt })),
            joinRequests: joinRequests.map((r) => ({ id: r.id, waId: r.waId, requestedAt: r.requestedAt })),
        };
    }

    /** Asks Meta for a new group; its id and invite link come back in the group_create webhook. */
    async create(orgId: string, userId: string, input: CreateGroupInput) {
        const subject = input.subject.trim();
        const description = input.description?.trim() || undefined;
        if (!subject || subject.length > GROUP_SUBJECT_MAX) throw new BadRequestException(`Name the group in 1 to ${GROUP_SUBJECT_MAX} characters.`);
        if (description && description.length > GROUP_DESCRIPTION_MAX) throw new BadRequestException(`The description can be at most ${GROUP_DESCRIPTION_MAX} characters.`);
        const channel = await this.prisma.channel.findFirst({
            where: { id: input.channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP },
            select: { id: true },
        });
        if (!channel) throw new NotFoundException('WhatsApp number not found');
        const a = await this.access.get(channel.id);
        if (a.onBusinessApp) throw new BadRequestException('This number is shared with the WhatsApp Business app; Meta does not allow groups on it.');
        if (a.status !== ChannelStatus.CONNECTED || !a.isEnabled) throw new BadRequestException('Reconnect this number first.');

        const joinApprovalMode = input.joinApprovalMode ?? 'auto_approve';
        const res = await this.call<{ request_id?: string }>(a, 'POST', `/${a.address}/groups`, {
            messaging_product: 'whatsapp',
            subject,
            ...(description ? { description } : {}),
            join_approval_mode: joinApprovalMode,
        });
        const group = await this.prisma.whatsAppGroup.create({
            data: {
                organizationId: orgId,
                channelId: channel.id,
                requestId: res.request_id ?? null,
                subject,
                description: description ?? null,
                joinApprovalMode,
                createdByUserId: userId,
            },
            include: this.listInclude,
        });
        return this.view(group);
    }

    /** Re-reads the group, its invite link and its join requests from Meta. */
    async refresh(orgId: string, id: string) {
        const group = await this.active(orgId, id);
        const a = await this.access.get(group.channelId);
        const info = await this.call<{
            subject?: string;
            description?: string;
            participants?: Array<{ wa_id?: string }>;
            join_approval_mode?: string;
            suspended?: boolean | string;
            total_participant_count?: number | string;
        }>(a, 'GET', `/${group.externalId}`, undefined, { fields: GROUP_FIELDS });
        const link = await this.call<{ invite_link?: string }>(a, 'GET', `/${group.externalId}/invite_link`);
        const requests = group.joinApprovalMode === 'approval_required'
            ? await this.call<{ data?: Array<{ join_request_id?: string; wa_id?: string; creation_timestamp?: number | string }> }>(a, 'GET', `/${group.externalId}/join_requests`)
            : { data: [] };

        const present = (info.participants ?? []).map((p) => p.wa_id).filter((w): w is string => !!w);
        const suspended = info.suspended === true || info.suspended === 'true';
        await this.prisma.$transaction(async (tx) => {
            await tx.whatsAppGroup.update({
                where: { id: group.id },
                data: {
                    subject: info.subject ?? group.subject,
                    description: info.description ?? group.description,
                    joinApprovalMode: info.join_approval_mode ?? group.joinApprovalMode,
                    inviteLink: link.invite_link ?? group.inviteLink,
                    participantCount: Number(info.total_participant_count ?? present.length) || present.length,
                    status: suspended ? WhatsAppGroupStatus.SUSPENDED : WhatsAppGroupStatus.ACTIVE,
                },
            });
            for (const waId of present) {
                await tx.whatsAppGroupParticipant.upsert({
                    where: { groupId_waId: { groupId: group.id, waId } },
                    create: { groupId: group.id, waId },
                    update: { leftAt: null, leftBy: null },
                });
            }
            await tx.whatsAppGroupParticipant.updateMany({
                where: { groupId: group.id, leftAt: null, waId: { notIn: present } },
                data: { leftAt: new Date() },
            });
            for (const r of requests.data ?? []) {
                if (!r.join_request_id || !r.wa_id) continue;
                await tx.whatsAppGroupJoinRequest.upsert({
                    where: { groupId_externalId: { groupId: group.id, externalId: r.join_request_id } },
                    create: { groupId: group.id, externalId: r.join_request_id, waId: r.wa_id, requestedAt: new Date(Number(r.creation_timestamp ?? 0) * 1000 || Date.now()) },
                    update: {},
                });
            }
            if (info.subject && group.contactId) await tx.channelContact.update({ where: { id: group.contactId }, data: { displayName: info.subject } });
        });
        return this.get(orgId, id);
    }

    async update(orgId: string, id: string, input: { subject?: string; description?: string }) {
        const group = await this.active(orgId, id);
        const subject = input.subject?.trim();
        const description = input.description?.trim();
        if (subject !== undefined && (!subject || subject.length > GROUP_SUBJECT_MAX)) throw new BadRequestException(`Name the group in 1 to ${GROUP_SUBJECT_MAX} characters.`);
        if (description !== undefined && description.length > GROUP_DESCRIPTION_MAX) throw new BadRequestException(`The description can be at most ${GROUP_DESCRIPTION_MAX} characters.`);
        const a = await this.access.get(group.channelId);
        await this.call(a, 'POST', `/${group.externalId}`, {
            messaging_product: 'whatsapp',
            ...(subject !== undefined ? { subject } : {}),
            ...(description !== undefined ? { description } : {}),
        });
        // The group_settings_update webhook confirms; the team sees the change at once.
        await this.applySettings(group, subject ?? null, description ?? null);
        return this.get(orgId, id);
    }

    /** Every earlier invite link stops working. */
    async resetInviteLink(orgId: string, id: string) {
        const group = await this.active(orgId, id);
        const a = await this.access.get(group.channelId);
        const res = await this.call<{ invite_link?: string }>(a, 'POST', `/${group.externalId}/invite_link`, { messaging_product: 'whatsapp' });
        if (!res.invite_link) throw new BadRequestException('WhatsApp did not return a new invite link.');
        await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { inviteLink: res.invite_link } });
        return this.get(orgId, id);
    }

    /** Meta: a removed participant cannot rejoin with the invite link. */
    async removeParticipant(orgId: string, id: string, waId: string) {
        const group = await this.active(orgId, id);
        const participant = await this.prisma.whatsAppGroupParticipant.findUnique({ where: { groupId_waId: { groupId: group.id, waId } } });
        if (!participant || participant.leftAt) throw new NotFoundException('That person is not in the group.');
        const a = await this.access.get(group.channelId);
        await this.call(a, 'DELETE', `/${group.externalId}/participants`, { messaging_product: 'whatsapp', participants: [{ user: waId }] });
        return this.get(orgId, id);
    }

    async decideJoinRequest(orgId: string, userId: string, id: string, requestId: string, approve: boolean) {
        const group = await this.active(orgId, id);
        const request = await this.prisma.whatsAppGroupJoinRequest.findFirst({ where: { id: requestId, groupId: group.id, status: 'PENDING' } });
        if (!request) throw new NotFoundException('Join request not found');
        if (approve) {
            const count = await this.prisma.whatsAppGroupParticipant.count({ where: { groupId: group.id, leftAt: null } });
            if (count >= GROUP_MAX_PARTICIPANTS) throw new BadRequestException('A group can have at most 8 participants besides your business.');
        }
        const a = await this.access.get(group.channelId);
        const res = await this.call<{ failed_join_requests?: Array<{ join_request_id?: string; errors?: Array<{ message?: string; error_data?: { details?: string } }> }> }>(
            a, approve ? 'POST' : 'DELETE', `/${group.externalId}/join_requests`, { messaging_product: 'whatsapp', join_requests: [request.externalId] },
        );
        const failed = res.failed_join_requests?.find((f) => f.join_request_id === request.externalId);
        if (failed) {
            const why = failed.errors?.[0]?.error_data?.details ?? failed.errors?.[0]?.message ?? 'WhatsApp did not accept it.';
            throw new BadRequestException(`The request could not be ${approve ? 'approved' : 'declined'}: ${why}`);
        }
        await this.prisma.whatsAppGroupJoinRequest.update({
            where: { id: request.id },
            data: { status: approve ? 'APPROVED' : 'REJECTED', decidedAt: new Date(), decidedByUserId: userId },
        });
        return this.get(orgId, id);
    }

    /** Removes everyone, the business included; the group_delete webhook confirms. */
    async remove(orgId: string, id: string) {
        const group = await this.load(orgId, id);
        if (group.status === WhatsAppGroupStatus.DELETED || group.status === WhatsAppGroupStatus.DELETING) return this.view(group);
        if (!group.externalId) {
            // Never created at Meta (still waiting, or failed): nothing to ask.
            const done = await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { status: WhatsAppGroupStatus.DELETED }, include: this.listInclude });
            return this.view(done);
        }
        const a = await this.access.get(group.channelId);
        await this.call(a, 'DELETE', `/${group.externalId}`);
        const updated = await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { status: WhatsAppGroupStatus.DELETING }, include: this.listInclude });
        return this.view(updated);
    }

    async qr(orgId: string, id: string, format: 'svg' | 'png'): Promise<{ body: Buffer | string; type: string; filename: string }> {
        const group = await this.load(orgId, id);
        if (!group.inviteLink) throw new BadRequestException('The group has no invite link yet.');
        const filename = `${group.subject.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'whatsapp-group'}-invite.${format}`;
        if (format === 'png') return { body: await QRCode.toBuffer(group.inviteLink, { width: 1024, margin: 2, errorCorrectionLevel: 'M' }), type: 'image/png', filename };
        return { body: await QRCode.toString(group.inviteLink, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), type: 'image/svg+xml', filename };
    }

    // ─── From WhatsApp ───────────────────────────────────────────────────

    /** A participant's message in a group, into the group's chat. */
    async recordInbound(channel: IngestChannel, m: WaMessage): Promise<void> {
        const waId = m.from?.waId ?? m.from?.userId;
        if (!m.groupId || !waId) return;
        const group = await this.groupFor(channel, m.groupId);
        if (!group?.contactId) return;
        const name = m.from?.profileName ?? null;
        await this.prisma.whatsAppGroupParticipant.upsert({
            where: { groupId_waId: { groupId: group.id, waId } },
            create: { groupId: group.id, waId, name },
            update: name ? { name } : {},
        });
        await this.ingest.recordGroupInbound({
            channel,
            contactId: group.contactId,
            participant: { waId, name },
            externalId: m.id,
            occurredAt: m.timestamp,
            content: whatsAppContent(m),
            body: m.raw,
            replyToExternalId: m.context?.id ?? null,
        });
    }

    /** A groups webhook: lifecycle, participants, settings or status. */
    async onChange(channel: IngestChannel, field: WaGroupField, change: WaGroupChange): Promise<void> {
        const at = change.timestamp ?? new Date();
        const failure = change.errors[0] ? (change.errors[0].details ?? change.errors[0].message ?? 'WhatsApp refused it.') : null;
        switch (change.type) {
            case 'group_create': {
                const pending = change.requestId
                    ? await this.prisma.whatsAppGroup.findUnique({ where: { channelId_requestId: { channelId: channel.id, requestId: change.requestId } } })
                    : null;
                if (failure) {
                    if (pending) await this.prisma.whatsAppGroup.update({ where: { id: pending.id }, data: { status: WhatsAppGroupStatus.FAILED, statusReason: failure } });
                    return;
                }
                if (!change.groupId) return;
                const known = pending ?? (await this.prisma.whatsAppGroup.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: change.groupId } } }));
                const group = known
                    ? await this.prisma.whatsAppGroup.update({
                        where: { id: known.id },
                        data: {
                            externalId: change.groupId,
                            status: WhatsAppGroupStatus.ACTIVE,
                            statusReason: null,
                            inviteLink: change.inviteLink ?? known.inviteLink,
                            joinApprovalMode: change.joinApprovalMode ?? known.joinApprovalMode,
                            ...(change.subject ? { subject: change.subject } : {}),
                        },
                    })
                    : await this.prisma.whatsAppGroup.create({
                        data: {
                            organizationId: channel.organizationId,
                            channelId: channel.id,
                            externalId: change.groupId,
                            requestId: change.requestId,
                            subject: change.subject ?? 'WhatsApp group',
                            inviteLink: change.inviteLink,
                            joinApprovalMode: change.joinApprovalMode ?? 'auto_approve',
                            status: WhatsAppGroupStatus.ACTIVE,
                        },
                    });
                await this.ensureChat(channel, group, at);
                return;
            }
            case 'group_delete': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group) return;
                if (failure) {
                    await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { status: WhatsAppGroupStatus.ACTIVE, statusReason: `Not deleted: ${failure}` } });
                    return;
                }
                await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { status: WhatsAppGroupStatus.DELETED, statusReason: null } });
                if (group.contactId) {
                    await this.ingest.recordNotice(channel, group.contactId, 'The group was deleted. Everyone, your business included, was removed.', at);
                    await this.prisma.conversation.updateMany({
                        where: { contactId: group.contactId },
                        data: { status: ConversationStatus.CLOSED, closedAt: at, awaitingReplySince: null },
                    });
                }
                return;
            }
            case 'group_participants_add': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group) return;
                for (const waId of change.added) {
                    await this.prisma.whatsAppGroupParticipant.upsert({
                        where: { groupId_waId: { groupId: group.id, waId } },
                        create: { groupId: group.id, waId, joinedAt: at },
                        update: { leftAt: null, leftBy: null, joinedAt: at },
                    });
                    await this.prisma.whatsAppGroupJoinRequest.updateMany({
                        where: { groupId: group.id, waId, status: 'PENDING' },
                        data: { status: 'APPROVED', decidedAt: at },
                    });
                    const p = await this.prisma.whatsAppGroupParticipant.findUnique({ where: { groupId_waId: { groupId: group.id, waId } }, select: { name: true } });
                    if (group.contactId) await this.ingest.recordNotice(channel, group.contactId, `${participantLabel(waId, p?.name)} joined with the invite link.`, at);
                }
                await this.recount(group.id);
                return;
            }
            case 'group_participants_remove': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group) return;
                for (const waId of change.removed) {
                    const p = await this.prisma.whatsAppGroupParticipant.findUnique({ where: { groupId_waId: { groupId: group.id, waId } } });
                    if (p) await this.prisma.whatsAppGroupParticipant.update({ where: { id: p.id }, data: { leftAt: at, leftBy: change.initiatedBy } });
                    if (group.contactId) {
                        const who = participantLabel(waId, p?.name);
                        await this.ingest.recordNotice(channel, group.contactId, change.initiatedBy === 'business' ? `${who} was removed from the group.` : `${who} left the group.`, at);
                    }
                }
                if (change.failed.length && failure) {
                    await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { statusReason: `Not removed: ${change.failed.map((w) => `+${w}`).join(', ')} (${failure})` } });
                }
                await this.recount(group.id);
                return;
            }
            case 'group_join_request_created': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group || !change.joinRequestId || !change.waId) return;
                await this.prisma.whatsAppGroupJoinRequest.upsert({
                    where: { groupId_externalId: { groupId: group.id, externalId: change.joinRequestId } },
                    create: { groupId: group.id, externalId: change.joinRequestId, waId: change.waId, requestedAt: at },
                    update: { status: 'PENDING' },
                });
                this.publish(group);
                return;
            }
            case 'group_join_request_revoked': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group || !change.joinRequestId) return;
                await this.prisma.whatsAppGroupJoinRequest.updateMany({
                    where: { groupId: group.id, externalId: change.joinRequestId, status: 'PENDING' },
                    data: { status: 'REVOKED', decidedAt: at },
                });
                this.publish(group);
                return;
            }
            case 'group_settings_update': {
                const group = await this.byExternal(channel, change.groupId);
                if (group) await this.applySettings(group, change.subject, change.description);
                return;
            }
            case 'group_suspend':
            case 'group_suspend_cleared': {
                const group = await this.byExternal(channel, change.groupId);
                if (!group) return;
                const suspended = change.type === 'group_suspend';
                await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { status: suspended ? WhatsAppGroupStatus.SUSPENDED : WhatsAppGroupStatus.ACTIVE } });
                if (group.contactId) {
                    await this.ingest.recordNotice(channel, group.contactId, suspended ? 'WhatsApp suspended the group. It cannot be messaged until the suspension is lifted.' : 'WhatsApp lifted the group’s suspension.', at);
                }
                return;
            }
            default:
                this.logger.log(`Group webhook ${field}/${change.type} for ${change.groupId ?? 'no group'} not handled`);
        }
    }

    // ─── Inside ──────────────────────────────────────────────────────────

    private readonly listInclude = {
        channel: { select: { name: true } },
        contact: { select: { conversations: { select: { id: true }, take: 1 } } },
        _count: { select: { joinRequests: { where: { status: 'PENDING' } } } },
    } satisfies Prisma.WhatsAppGroupInclude;

    private view(g: Prisma.WhatsAppGroupGetPayload<{ include: WhatsAppGroupsService['listInclude'] }>) {
        return {
            id: g.id,
            channelId: g.channelId,
            channelName: g.channel.name,
            subject: g.subject,
            description: g.description,
            joinApprovalMode: g.joinApprovalMode,
            inviteLink: g.inviteLink,
            status: g.status,
            statusReason: g.statusReason,
            participantCount: g.participantCount,
            pendingJoinRequests: g._count.joinRequests,
            conversationId: g.contact?.conversations[0]?.id ?? null,
            createdAt: g.createdAt,
        };
    }

    private async load(orgId: string, id: string) {
        const group = await this.prisma.whatsAppGroup.findFirst({ where: { id, organizationId: orgId }, include: this.listInclude });
        if (!group) throw new NotFoundException('Group not found');
        return group;
    }

    /** A group Meta knows and that can still be changed. */
    private async active(orgId: string, id: string) {
        const group = await this.load(orgId, id);
        if (!group.externalId || group.status === WhatsAppGroupStatus.CREATING) throw new ConflictException('WhatsApp is still creating this group.');
        if (group.status === WhatsAppGroupStatus.DELETED || group.status === WhatsAppGroupStatus.DELETING || group.status === WhatsAppGroupStatus.FAILED) {
            throw new ConflictException('This group no longer exists on WhatsApp.');
        }
        return group as typeof group & { externalId: string };
    }

    private byExternal(channel: IngestChannel, groupId: string | null) {
        if (!groupId) return Promise.resolve(null);
        return this.prisma.whatsAppGroup.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: groupId } } });
    }

    /** The group a message names: known, or one made outside Collabo, recorded now. */
    private async groupFor(channel: IngestChannel, groupId: string): Promise<WhatsAppGroup | null> {
        const known = await this.byExternal(channel, groupId);
        if (known) return known.contactId ? known : this.ensureChat(channel, known, new Date());
        let subject = 'WhatsApp group';
        try {
            const a = await this.access.get(channel.id);
            subject = (await this.call<{ subject?: string }>(a, 'GET', `/${groupId}`, undefined, { fields: 'subject' })).subject ?? subject;
        } catch (err) {
            this.logger.warn(`Group ${groupId}: could not read its name: ${err instanceof Error ? err.message : err}`);
        }
        try {
            const group = await this.prisma.whatsAppGroup.create({
                data: { organizationId: channel.organizationId, channelId: channel.id, externalId: groupId, subject, status: WhatsAppGroupStatus.ACTIVE },
            });
            return this.ensureChat(channel, group, new Date());
        } catch (err) {
            // Two messages for a new group raced; the other created it.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return this.byExternal(channel, groupId);
            throw err;
        }
    }

    /** The contact and conversation that carry the group's chat in the inbox. */
    private async ensureChat(channel: IngestChannel, group: WhatsAppGroup, at: Date): Promise<WhatsAppGroup> {
        if (group.contactId || !group.externalId) return group;
        const externalId = groupContactExternalId(group.externalId);
        const contact = await this.prisma.channelContact.upsert({
            where: { channelId_externalId: { channelId: channel.id, externalId } },
            create: { organizationId: channel.organizationId, channelId: channel.id, platform: ChannelPlatform.WHATSAPP, externalId, displayName: group.subject, isGroup: true },
            update: { displayName: group.subject, isGroup: true },
        });
        const conversation = await this.prisma.conversation.upsert({
            where: { channelId_contactId: { channelId: channel.id, contactId: contact.id } },
            create: {
                organizationId: channel.organizationId,
                channelId: channel.id,
                contactId: contact.id,
                platform: ChannelPlatform.WHATSAPP,
                status: ConversationStatus.OPEN,
                openedAt: at,
                lastMessageAt: at,
                lastMessagePreview: 'Group created',
                assignedUserId: group.createdByUserId,
            },
            update: {},
        });
        const updated = await this.prisma.whatsAppGroup.update({ where: { id: group.id }, data: { contactId: contact.id } });
        await this.ingest.recordNotice(channel, contact.id, 'Group created. Share the invite link to bring people in; a template starts the chat until someone writes.', at);
        this.events.publish(channel.organizationId, { type: 'conversation.updated', conversationId: conversation.id });
        return updated;
    }

    private async applySettings(group: WhatsAppGroup, subject: string | null, description: string | null) {
        if (subject === null && description === null) return;
        await this.prisma.whatsAppGroup.update({
            where: { id: group.id },
            data: { ...(subject !== null ? { subject } : {}), ...(description !== null ? { description } : {}) },
        });
        if (subject !== null && group.contactId) await this.prisma.channelContact.update({ where: { id: group.contactId }, data: { displayName: subject } });
        this.publish(group);
    }

    private async recount(groupId: string) {
        const count = await this.prisma.whatsAppGroupParticipant.count({ where: { groupId, leftAt: null } });
        const group = await this.prisma.whatsAppGroup.update({ where: { id: groupId }, data: { participantCount: count } });
        this.publish(group);
    }

    /** Tells open inboxes the group's chat changed. */
    private publish(group: WhatsAppGroup) {
        if (!group.contactId) return;
        void this.prisma.conversation
            .findFirst({ where: { contactId: group.contactId }, select: { id: true } })
            .then((c) => c && this.events.publish(group.organizationId, { type: 'conversation.updated', conversationId: c.id }));
    }

    private async call<T = Record<string, unknown>>(
        a: Awaited<ReturnType<ChannelAccessService['get']>>,
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: Record<string, unknown>,
        query?: Record<string, string>,
    ): Promise<T> {
        try {
            const res = await this.metaGraph.request<T>({
                method,
                path,
                accessToken: a.token,
                ...(body ? { body } : {}),
                ...(query ? { query } : {}),
                scopes: a.scopes,
                priority: Priority.INTERACTIVE,
                channelId: a.id,
            });
            return res.data;
        } catch (err) {
            const known = groupErrorMessage(err);
            if (known) throw new BadRequestException(known);
            if (err instanceof MetaGraphError) throw new BadRequestException(`WhatsApp refused it: ${err.message}`);
            throw err;
        }
    }
}
