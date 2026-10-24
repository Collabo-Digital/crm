import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, ConversationStatus, Prisma, WhatsAppCall, WhatsAppCallDirection, WhatsAppCallStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { Priority } from '../../rate-limit/rate-limit.types';
import { ChannelAccessService } from '../../messaging/channel-access.service';
import { ContactIdentityService } from '../../messaging/contact-identity.service';
import { contactName } from '../../messaging/contact-name';
import { InboxEventsService } from '../../messaging/inbox-events.service';
import { IngestChannel, MessageIngestService } from '../../messaging/message-ingest.service';
import { MessagingSendService } from '../../messaging/send/messaging-send.service';
import type { WaCall, WaContactRef } from '../../automation/platforms/whatsapp/whatsapp-webhook.parser';

/** Meta allows 30 to 60 seconds to answer, then ends the call; past this, a call whose terminate webhook was lost stops ringing. */
const RINGING_MS = 90_000;
const LIVE: WhatsAppCallStatus[] = [WhatsAppCallStatus.RINGING, WhatsAppCallStatus.CONNECTING, WhatsAppCallStatus.ACTIVE];

/** Meta's calling errors that read better in words. */
const CALL_ERRORS: Record<number, string> = {
    138006: 'This person has not allowed calls from your business. Ask for permission first.',
};

export interface CallSettingsInput {
    enabled: boolean;
    /** Show the call button in the chat with the business. */
    showCallButton: boolean;
    /** A person who calls in allows the business to call back for a while. */
    callbackPermission: boolean;
}

const minutes = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m} min ${s} s` : `${s} s`;
};

/**
 * WhatsApp voice calls (Business Calling API) answered and placed from a
 * teammate's browser. Collabo relays the signalling: a person's call arrives
 * with Meta's SDP offer, the browser answers it (pre_accept, then accept with
 * the same answer); a business call goes out with the browser's offer and
 * Meta's answer comes back on the calls webhook. Media flows between the
 * browser and Meta over WebRTC. Calling is not offered on numbers shared with
 * the WhatsApp Business app, nor in groups.
 */
@Injectable()
export class WhatsAppCallsService {
    private readonly logger = new Logger(WhatsAppCallsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly metaGraph: MetaGraphClient,
        private readonly access: ChannelAccessService,
        private readonly identity: ContactIdentityService,
        private readonly ingest: MessageIngestService,
        private readonly events: InboxEventsService,
        private readonly sender: MessagingSendService,
    ) { }

    // ─── For the browser ─────────────────────────────────────────────────

    /** Calls ringing, connecting or in progress, for every teammate's call dock. */
    async live(orgId: string) {
        const calls = await this.prisma.whatsAppCall.findMany({
            where: {
                organizationId: orgId,
                status: { in: LIVE },
                OR: [{ status: { not: WhatsAppCallStatus.RINGING } }, { startedAt: { gt: new Date(Date.now() - RINGING_MS) } }],
            },
            include: { contact: true },
            orderBy: { startedAt: 'asc' },
        });
        return calls.map((c) => this.view(c));
    }

    /** One call, with its SDPs, for the browser that answers or placed it. */
    async get(orgId: string, id: string) {
        const call = await this.load(orgId, id);
        return { ...this.view(call), offerSdp: call.offerSdp, answerSdp: call.answerSdp };
    }

    /** A person's call, answered in this browser: the first teammate to answer takes it. */
    async accept(orgId: string, userId: string, id: string, sdp: string) {
        const call = await this.load(orgId, id);
        if (call.direction !== WhatsAppCallDirection.USER_INITIATED || call.status !== WhatsAppCallStatus.RINGING) {
            throw new ConflictException('This call is no longer ringing.');
        }
        const taken = await this.prisma.whatsAppCall.updateMany({
            where: { id: call.id, status: WhatsAppCallStatus.RINGING },
            data: { status: WhatsAppCallStatus.CONNECTING, agentUserId: userId, answerSdp: sdp },
        });
        if (!taken.count) throw new ConflictException('Someone else answered this call.');
        const a = await this.access.get(call.channelId);
        const session = { sdp_type: 'answer', sdp };
        try {
            // Meta: pre-accept lets the media path start; accept must carry the same answer.
            await this.call(a, { messaging_product: 'whatsapp', call_id: call.externalId, action: 'pre_accept', session });
            await this.call(a, { messaging_product: 'whatsapp', call_id: call.externalId, action: 'accept', session });
        } catch (err) {
            await this.finish(call, WhatsAppCallStatus.FAILED, new Date(), { failure: this.reason(err) });
            throw err;
        }
        const updated = await this.prisma.whatsAppCall.update({
            where: { id: call.id },
            data: { status: WhatsAppCallStatus.ACTIVE, answeredAt: new Date() },
            include: { contact: true },
        });
        this.publish(updated);
        return this.view(updated);
    }

    async reject(orgId: string, userId: string, id: string) {
        const call = await this.load(orgId, id);
        if (call.direction !== WhatsAppCallDirection.USER_INITIATED || call.status !== WhatsAppCallStatus.RINGING) {
            throw new ConflictException('This call is no longer ringing.');
        }
        const a = await this.access.get(call.channelId);
        await this.call(a, { messaging_product: 'whatsapp', call_id: call.externalId, action: 'reject' });
        await this.finish(call, WhatsAppCallStatus.REJECTED, new Date(), { agentUserId: userId });
        return { ok: true };
    }

    /** Hangs up; Meta's terminate webhook then reports the duration. */
    async terminate(orgId: string, id: string) {
        const call = await this.load(orgId, id);
        if (!LIVE.includes(call.status)) return { ok: true };
        const a = await this.access.get(call.channelId);
        try {
            await this.call(a, { messaging_product: 'whatsapp', call_id: call.externalId, action: 'terminate' });
        } catch (err) {
            // The other side may have hung up first; the call is over either way.
            this.logger.warn(`Call ${call.id}: terminate refused: ${this.reason(err)}`);
        }
        const answered = call.status === WhatsAppCallStatus.ACTIVE;
        const end = new Date();
        // Meta's terminate webhook brings the exact duration later; the chat's note is written now.
        const duration = answered && call.answeredAt ? { durationSeconds: Math.max(0, Math.round((end.getTime() - call.answeredAt.getTime()) / 1000)) } : {};
        await this.finish(call, answered ? WhatsAppCallStatus.COMPLETED : WhatsAppCallStatus.MISSED, end, duration);
        return { ok: true };
    }

    /** A business call, placed from this browser with its SDP offer, to someone who allowed calls. */
    async start(orgId: string, userId: string, conversationId: string, sdp: string) {
        const conversation = await this.prisma.conversation.findFirst({
            where: { id: conversationId, organizationId: orgId },
            include: { contact: true },
        });
        if (!conversation) throw new NotFoundException('Conversation not found');
        if (conversation.platform !== ChannelPlatform.WHATSAPP || conversation.contact.isGroup) {
            throw new BadRequestException('Calls are for one-to-one WhatsApp chats.');
        }
        const a = await this.access.get(conversation.channelId);
        if (a.onBusinessApp) throw new BadRequestException('Calls are not available on a number shared with the WhatsApp Business app.');
        const busy = await this.prisma.whatsAppCall.findFirst({ where: { conversationId, status: { in: LIVE }, startedAt: { gt: new Date(Date.now() - 2 * 3600_000) } } });
        if (busy) throw new ConflictException('There is already a call in this chat.');

        const who = this.recipient(conversation.contact);
        const permission = await this.permission(a, who);
        if (!permission.canCall) {
            throw new ConflictException(`${contactName(conversation.contact)} has not allowed calls from your business. Ask for permission first.`);
        }
        const res = await this.call<{ calls?: Array<{ id?: string }> }>(a, {
            messaging_product: 'whatsapp',
            ...(who.waId ? { to: who.waId } : { recipient: who.userId }),
            action: 'connect',
            session: { sdp_type: 'offer', sdp },
        });
        const externalId = res.calls?.[0]?.id;
        if (!externalId) throw new BadRequestException('WhatsApp did not start the call.');
        const call = await this.prisma.whatsAppCall.create({
            data: {
                organizationId: orgId,
                channelId: conversation.channelId,
                conversationId,
                contactId: conversation.contactId,
                externalId,
                direction: WhatsAppCallDirection.BUSINESS_INITIATED,
                status: WhatsAppCallStatus.CONNECTING,
                offerSdp: sdp,
                agentUserId: userId,
            },
            include: { contact: true },
        });
        this.publish(call);
        return this.view(call);
    }

    /** Whether this person can be called now, from Meta (permission and limits). */
    async permissionFor(orgId: string, conversationId: string) {
        const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, organizationId: orgId }, include: { contact: true } });
        if (!conversation) throw new NotFoundException('Conversation not found');
        if (conversation.platform !== ChannelPlatform.WHATSAPP || conversation.contact.isGroup) return { canCall: false, canAsk: false, status: 'unavailable' };
        const a = await this.access.get(conversation.channelId);
        if (a.onBusinessApp) return { canCall: false, canAsk: false, status: 'unavailable' };
        return this.permission(a, this.recipient(conversation.contact));
    }

    /** Asks the person, in the chat, to allow calls (Meta's call_permission_request; inside the 24-hour window). */
    async requestPermission(orgId: string, userId: string, conversationId: string, text?: string) {
        return this.sender.send({
            organizationId: orgId,
            conversationId,
            payload: { type: 'call_permission_request', text: text?.trim() || 'We would like to call you on WhatsApp about this. Tap below to allow it.' },
            origin: 'agent',
            actorUserId: userId,
        });
    }

    async settings(orgId: string, channelId: string) {
        const a = await this.channel(orgId, channelId);
        if (a.onBusinessApp) return { available: false, reason: 'Calls are not available on a number shared with the WhatsApp Business app.', enabled: false, showCallButton: false, callbackPermission: false };
        const res = await this.graph<{ calling?: { status?: string; call_icon_visibility?: string; callback_permission_status?: string } }>(a, 'GET', `/${a.address}/settings`);
        const c = res.calling ?? {};
        return {
            available: true,
            reason: null,
            enabled: c.status === 'ENABLED',
            showCallButton: c.call_icon_visibility !== 'DISABLE_ALL',
            callbackPermission: c.callback_permission_status === 'ENABLED',
        };
    }

    async saveSettings(orgId: string, channelId: string, input: CallSettingsInput) {
        const a = await this.channel(orgId, channelId);
        if (a.onBusinessApp) throw new BadRequestException('Calls are not available on a number shared with the WhatsApp Business app.');
        await this.graph(a, 'POST', `/${a.address}/settings`, {
            calling: {
                status: input.enabled ? 'ENABLED' : 'DISABLED',
                call_icon_visibility: input.showCallButton ? 'DEFAULT' : 'DISABLE_ALL',
                callback_permission_status: input.callbackPermission ? 'ENABLED' : 'DISABLED',
            },
        });
        return this.settings(orgId, channelId);
    }

    // ─── From WhatsApp ───────────────────────────────────────────────────

    async onCall(channel: IngestChannel, c: WaCall): Promise<void> {
        const at = c.timestamp ?? new Date();
        const known = await this.prisma.whatsAppCall.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: c.id } }, include: { contact: true } });
        if (c.event === 'connect') {
            if (c.direction === 'BUSINESS_INITIATED') {
                // Meta's answer to the browser's offer.
                if (known && c.sdp && !known.answerSdp) {
                    const updated = await this.prisma.whatsAppCall.update({ where: { id: known.id }, data: { answerSdp: c.sdp }, include: { contact: true } });
                    this.publish(updated);
                }
                return;
            }
            // Webhooks can repeat; a terminate can also come before its connect.
            if (known || !c.sdp || !c.user) return;
            const { contact, conversation } = await this.chatFor(channel, c.user, at);
            if (!conversation) {
                // Blocked: decline at once, without ringing the team or reopening the chat.
                await this.access
                    .get(channel.id)
                    .then((a) => this.call(a, { messaging_product: 'whatsapp', call_id: c.id, action: 'reject' }))
                    .catch((err) => this.logger.warn(`Call ${c.id} from blocked contact ${contact.id} not declined: ${this.reason(err)}`));
                return;
            }
            const call = await this.prisma.whatsAppCall.create({
                data: {
                    organizationId: channel.organizationId,
                    channelId: channel.id,
                    conversationId: conversation.id,
                    contactId: contact.id,
                    externalId: c.id,
                    direction: WhatsAppCallDirection.USER_INITIATED,
                    status: WhatsAppCallStatus.RINGING,
                    offerSdp: c.sdp,
                    startedAt: at,
                },
                include: { contact: true },
            });
            this.publish(call);
            return;
        }
        if (c.event === 'terminate') {
            const failed = c.status === 'FAILED';
            const call = known ?? (c.user ? await this.recordMissed(channel, c, at) : null);
            if (!call) return;
            const answered = !!(c.startTime || call.answeredAt || call.status === WhatsAppCallStatus.ACTIVE);
            const status = failed
                ? WhatsAppCallStatus.FAILED
                : answered
                    ? WhatsAppCallStatus.COMPLETED
                    : call.status === WhatsAppCallStatus.REJECTED
                        ? WhatsAppCallStatus.REJECTED
                        : WhatsAppCallStatus.MISSED;
            const duration = c.duration ?? (c.startTime && c.endTime ? Math.round((c.endTime.getTime() - c.startTime.getTime()) / 1000) : null);
            await this.finish(call, status, c.endTime ?? at, {
                ...(duration !== null ? { durationSeconds: duration } : {}),
                ...(c.startTime && !call.answeredAt ? { answeredAt: c.startTime } : {}),
                ...(failed ? { failure: c.errors[0]?.details ?? c.errors[0]?.message ?? 'WhatsApp ended the call.' } : {}),
            });
        }
    }

    /** A business call's progress on the person's phone. */
    async onStatus(channel: IngestChannel, callId: string, status: string, at: Date | null): Promise<void> {
        const call = await this.prisma.whatsAppCall.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: callId } }, include: { contact: true } });
        if (!call || !LIVE.includes(call.status)) return;
        const when = at ?? new Date();
        if (status === 'RINGING') {
            const updated = await this.prisma.whatsAppCall.update({ where: { id: call.id }, data: { status: WhatsAppCallStatus.RINGING }, include: { contact: true } });
            this.publish(updated);
        } else if (status === 'ACCEPTED') {
            const updated = await this.prisma.whatsAppCall.update({ where: { id: call.id }, data: { status: WhatsAppCallStatus.ACTIVE, answeredAt: when }, include: { contact: true } });
            // Meta: a person answering the business's call opens the 24-hour window.
            if (call.conversationId) await this.prisma.conversation.update({ where: { id: call.conversationId }, data: { lastInboundAt: when } });
            this.publish(updated);
        } else if (status === 'REJECTED') {
            await this.finish(call, WhatsAppCallStatus.REJECTED, when);
        }
    }

    /**
     * The person's answer to a call permission request, or WhatsApp's own:
     * a grant when they call in (with callback permission on), a withdrawal
     * after 4 unanswered calls. WhatsApp's own is noted in the chat instead of
     * arriving as a message from them.
     */
    async onPermissionReply(channel: IngestChannel, user: WaContactRef, raw: Record<string, unknown>, at: Date | null): Promise<void> {
        const reply = ((raw.interactive as { call_permission_reply?: Record<string, unknown> } | undefined)?.call_permission_reply) ?? {};
        const accepted = reply.response === 'accept';
        const permanent = reply.is_permanent === true;
        const expires = Number(reply.expiration_timestamp);
        const contact = await this.prisma.$transaction(async (tx) => {
            const contact = await this.identity.resolve(tx, channel, this.ref(user), { kind: 'none' });
            return tx.channelContact.update({
                where: { id: contact.id },
                data: {
                    callPermission: !accepted ? 'declined' : permanent ? 'permanent' : 'temporary',
                    callPermissionUntil: accepted && !permanent && Number.isFinite(expires) && expires > 0 ? new Date(expires * 1000) : null,
                },
            });
        });
        if (reply.response_source === 'automatic') {
            const text = accepted ? 'Calling in allowed the business to call them back' : 'WhatsApp withdrew call permission after unanswered calls';
            await this.ingest.recordNotice(channel, contact.id, text, at ?? new Date());
        }
    }

    // ─── Inside ──────────────────────────────────────────────────────────

    private view(c: WhatsAppCall & { contact: { displayName: string | null; addressBookName: string | null; username: string | null; phone: string | null; externalId: string } | null }) {
        return {
            id: c.id,
            conversationId: c.conversationId,
            direction: c.direction,
            status: c.status,
            contactName: c.contact ? contactName(c.contact) : 'WhatsApp caller',
            phone: c.contact?.phone ?? null,
            agentUserId: c.agentUserId,
            startedAt: c.startedAt,
            answeredAt: c.answeredAt,
            endedAt: c.endedAt,
            durationSeconds: c.durationSeconds,
            failure: c.failure,
            hasAnswer: !!c.answerSdp,
        };
    }

    private async load(orgId: string, id: string) {
        const call = await this.prisma.whatsAppCall.findFirst({ where: { id, organizationId: orgId }, include: { contact: true } });
        if (!call) throw new NotFoundException('Call not found');
        return call;
    }

    private async channel(orgId: string, channelId: string) {
        const channel = await this.prisma.channel.findFirst({ where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP }, select: { id: true } });
        if (!channel) throw new NotFoundException('WhatsApp number not found');
        return this.access.get(channel.id);
    }

    private ref(user: WaContactRef) {
        return { platform: ChannelPlatform.WHATSAPP, userId: user.userId, waId: user.waId, username: user.username, profileName: user.profileName };
    }

    private recipient(contact: { waId: string | null; externalId: string }) {
        const bsuid = /^[A-Z]{2}\./.test(contact.externalId);
        return { waId: contact.waId ?? (bsuid ? null : contact.externalId), userId: bsuid ? contact.externalId : null };
    }

    private async permission(a: Awaited<ReturnType<ChannelAccessService['get']>>, who: { waId: string | null; userId: string | null }) {
        const res = await this.graph<{ permission?: { status?: string }; actions?: Array<{ action_name?: string; can_perform_action?: boolean }> }>(
            a, 'GET', `/${a.address}/call_permissions`, undefined, who.waId ? { user_wa_id: who.waId } : { recipient: who.userId ?? '' },
        );
        const can = (name: string) => res.actions?.find((x) => x.action_name === name)?.can_perform_action === true;
        return { status: res.permission?.status ?? 'no_permission', canCall: can('start_call'), canAsk: can('send_call_permission_request') };
    }

    /**
     * The contact and conversation a person's call belongs to; their call
     * opens the 24-hour window. No conversation for a blocked contact: like
     * their messages, their calls leave the chat closed.
     */
    private async chatFor(channel: IngestChannel, user: WaContactRef, at: Date) {
        return this.prisma.$transaction(async (tx) => {
            const contact = await this.identity.resolve(tx, channel, this.ref(user), { kind: 'none' });
            if (contact.blockedAt) return { contact, conversation: null };
            const existing = await tx.conversation.findUnique({ where: { channelId_contactId: { channelId: channel.id, contactId: contact.id } } });
            const conversation = existing
                ? await tx.conversation.update({
                    where: { id: existing.id },
                    data: { lastInboundAt: at, ...(existing.status === ConversationStatus.CLOSED ? { status: ConversationStatus.OPEN, closedAt: null, openedAt: at } : {}) },
                })
                : await tx.conversation.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        contactId: contact.id,
                        platform: ChannelPlatform.WHATSAPP,
                        customerId: contact.customerId,
                        status: ConversationStatus.OPEN,
                        openedAt: at,
                        lastInboundAt: at,
                        lastMessageAt: at,
                        lastMessagePreview: 'Incoming call',
                    },
                });
            return { contact, conversation };
        });
    }

    /** A call we only heard about when it ended (its connect was lost or came late). */
    private async recordMissed(channel: IngestChannel, c: WaCall, at: Date) {
        const { contact, conversation } = await this.chatFor(channel, c.user!, at);
        if (!conversation) return null;
        try {
            return await this.prisma.whatsAppCall.create({
                data: {
                    organizationId: channel.organizationId,
                    channelId: channel.id,
                    conversationId: conversation.id,
                    contactId: contact.id,
                    externalId: c.id,
                    direction: c.direction === 'BUSINESS_INITIATED' ? WhatsAppCallDirection.BUSINESS_INITIATED : WhatsAppCallDirection.USER_INITIATED,
                    status: WhatsAppCallStatus.RINGING,
                    startedAt: c.startTime ?? at,
                },
                include: { contact: true },
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                return this.prisma.whatsAppCall.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: c.id } }, include: { contact: true } });
            }
            throw err;
        }
    }

    /** Ends a call once, and posts how it went in the chat. */
    private async finish(
        call: WhatsAppCall & { contact: unknown },
        status: WhatsAppCallStatus,
        at: Date,
        extra: Partial<Pick<WhatsAppCall, 'durationSeconds' | 'answeredAt' | 'failure' | 'agentUserId'>> = {},
    ) {
        const done = await this.prisma.whatsAppCall.updateMany({
            where: { id: call.id, endedAt: null },
            data: { status, endedAt: at, ...extra },
        });
        if (!done.count) {
            // Already ended (the browser's hang-up came first): keep Meta's duration and outcome.
            if (extra.durationSeconds !== undefined || status === WhatsAppCallStatus.FAILED) {
                await this.prisma.whatsAppCall.update({ where: { id: call.id }, data: { status, ...extra } });
            }
            const latest = await this.prisma.whatsAppCall.findUnique({ where: { id: call.id }, include: { contact: true } });
            if (latest) this.publish(latest);
            return;
        }
        if (call.contactId) {
            const channel = await this.prisma.channel.findUnique({ where: { id: call.channelId }, select: { id: true, organizationId: true } });
            const a = channel ? await this.access.get(channel.id) : null;
            const ingestChannel: IngestChannel | null = channel && a ? { id: channel.id, organizationId: channel.organizationId, platform: ChannelPlatform.WHATSAPP, address: a.address } : null;
            const incoming = call.direction === WhatsAppCallDirection.USER_INITIATED;
            const text =
                status === WhatsAppCallStatus.COMPLETED
                    ? `${incoming ? 'Incoming' : 'Outgoing'} WhatsApp call${extra.durationSeconds ? ` · ${minutes(extra.durationSeconds)}` : ''}`
                    : status === WhatsAppCallStatus.MISSED
                        ? incoming ? 'Missed WhatsApp call' : 'WhatsApp call not answered'
                        : status === WhatsAppCallStatus.REJECTED
                            ? incoming ? 'WhatsApp call declined by the team' : 'WhatsApp call declined'
                            : `WhatsApp call failed${extra.failure ? `: ${extra.failure}` : ''}`;
            if (ingestChannel) await this.ingest.recordNotice(ingestChannel, call.contactId, text, at);
        }
        const latest = await this.prisma.whatsAppCall.findUnique({ where: { id: call.id }, include: { contact: true } });
        if (latest) this.publish(latest);
    }

    private publish(call: WhatsAppCall) {
        if (call.conversationId) this.events.publish(call.organizationId, { type: 'call.updated', conversationId: call.conversationId, callId: call.id });
    }

    private reason(err: unknown): string {
        if (err instanceof BadRequestException) return err.message;
        return err instanceof Error ? err.message : String(err);
    }

    private call<T = Record<string, unknown>>(a: Awaited<ReturnType<ChannelAccessService['get']>>, body: Record<string, unknown>) {
        return this.graph<T>(a, 'POST', `/${a.address}/calls`, body);
    }

    private async graph<T = Record<string, unknown>>(
        a: Awaited<ReturnType<ChannelAccessService['get']>>,
        method: 'GET' | 'POST',
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
            if (err instanceof MetaGraphError) {
                const known = err.metaCode !== undefined ? CALL_ERRORS[err.metaCode] : undefined;
                throw new BadRequestException(known ?? `WhatsApp refused it: ${err.message}`);
            }
            throw err;
        }
    }
}
