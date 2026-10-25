import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelContact, ChannelPlatform, ChannelStatus, ConsentType, Prisma } from '@prisma/client';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { ConsentService } from '../messaging/consent.service';
import { ContactIdentityService } from '../messaging/contact-identity.service';
import { normalizePhone } from '../common/phone.util';
import {
    WidgetSettings,
    chatTarget,
    confirmationText,
    hostAllowed,
    hostOf,
    makeCode,
    normalizeDomain,
    parseWidgetSettings,
    referenceIn,
    signupCodeIn,
    waMe,
} from './growth.util';
import { widgetScript } from './widget-script';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const CHAT_PLATFORMS: ChannelPlatform[] = [ChannelPlatform.WHATSAPP, ChannelPlatform.FACEBOOK, ChannelPlatform.INSTAGRAM];
const BUTTON_LINK_NAME = 'Website chat button';
/// Sign-ups one store accepts in an hour. The form can be posted by scripts that
/// fake the Origin header, and every sign-up can start a template send.
const SIGNUPS_PER_HOUR = 200;
const SIGNUP_CODE_LENGTH = 6;
const CONFIRM_WITHIN_MS = 24 * 3600_000;

/**
 * Growth tools (Campaigns → Growth): chat links with QR codes, counted
 * through /l/:code, and the website chat button and number-capture pop-up,
 * served as /widget/:key.js. A WhatsApp chat that starts from a link carries
 * its reference in the first message; the contact gets the link's tag, which
 * "A contact gets a tag" automations can follow up.
 */
@Injectable()
export class GrowthService {
    private readonly logger = new Logger(GrowthService.name);
    private readonly api: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly identity: ContactIdentityService,
        private readonly consent: ConsentService,
        private readonly automationEvents: AutomationEventService,
        private readonly jobs: AutomationJobs,
        config: ConfigService,
    ) {
        this.api = `${(config.get<string>('appUrl') ?? 'http://localhost:3000').replace(/\/+$/, '')}/api/v1`;
    }

    // ─── Chat links ────────────────────────────────────────────────────

    async listLinks(orgId: string) {
        const rows = await this.prisma.growthLink.findMany({
            where: { organizationId: orgId, archivedAt: null },
            include: { channel: { select: { id: true, name: true, platform: true, credentials: true, externalStoreId: true, externalStoreUrl: true } } },
            orderBy: { createdAt: 'desc' },
        });
        const widget = await this.prisma.siteWidget.findUnique({ where: { organizationId: orgId }, select: { buttonLinkId: true } });
        return rows.map((r) => this.linkView(r, r.id === widget?.buttonLinkId));
    }

    async createLink(orgId: string, userId: string, input: { channelId: string; name: string; prefilledText?: string; tag?: string }) {
        const channel = await this.chatChannel(orgId, input.channelId);
        for (let attempt = 0; ; attempt++) {
            try {
                const row = await this.prisma.growthLink.create({
                    data: {
                        organizationId: orgId,
                        channelId: channel.id,
                        name: input.name.trim(),
                        code: makeCode(),
                        prefilledText: channel.platform === ChannelPlatform.WHATSAPP ? input.prefilledText?.trim() || null : null,
                        tag: input.tag?.trim() || null,
                        createdById: userId,
                    },
                    include: { channel: { select: { id: true, name: true, platform: true, credentials: true, externalStoreId: true, externalStoreUrl: true } } },
                });
                return this.linkView(row, false);
            } catch (err) {
                if (!isUniqueViolation(err) || attempt > 3) throw err;
            }
        }
    }

    async updateLink(orgId: string, id: string, input: { name?: string; prefilledText?: string | null; tag?: string | null }) {
        const link = await this.link(orgId, id);
        const row = await this.prisma.growthLink.update({
            where: { id: link.id },
            data: {
                ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                ...(input.prefilledText !== undefined && link.channel.platform === ChannelPlatform.WHATSAPP ? { prefilledText: input.prefilledText?.trim() || null } : {}),
                ...(input.tag !== undefined ? { tag: input.tag?.trim() || null } : {}),
            },
            include: { channel: { select: { id: true, name: true, platform: true, credentials: true, externalStoreId: true, externalStoreUrl: true } } },
        });
        return this.linkView(row, false);
    }

    async archiveLink(orgId: string, id: string) {
        const link = await this.link(orgId, id);
        const widget = await this.prisma.siteWidget.findUnique({ where: { organizationId: orgId }, select: { buttonLinkId: true } });
        if (widget?.buttonLinkId === link.id) throw new BadRequestException('This link is the website chat button’s; turn the button off instead.');
        await this.prisma.growthLink.update({ where: { id: link.id }, data: { archivedAt: new Date() } });
    }

    /** GET /l/:code: where the link opens. Counts the click; null when the link is gone. */
    async follow(code: string): Promise<string | null> {
        const link = await this.prisma.growthLink.findUnique({
            where: { code: code.toUpperCase() },
            include: { channel: { select: { platform: true, credentials: true, externalStoreId: true, externalStoreUrl: true, status: true } } },
        });
        if (!link || link.archivedAt) return null;
        const target = chatTarget(link.channel, link.code, link.prefilledText);
        if (!target) return null;
        await this.prisma.growthLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 }, lastClickAt: new Date() } });
        return target;
    }

    async qr(orgId: string, id: string, format: 'svg' | 'png'): Promise<{ body: Buffer | string; type: string; filename: string }> {
        const link = await this.link(orgId, id);
        const url = this.shortUrl(link.code);
        const filename = `${link.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'chat-link'}-qr.${format}`;
        if (format === 'png') return { body: await QRCode.toBuffer(url, { width: 1024, margin: 2, errorCorrectionLevel: 'M' }), type: 'image/png', filename };
        return { body: await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), type: 'image/svg+xml', filename };
    }

    /**
     * An inbound WhatsApp message: if it carries a link's reference, the
     * contact is tagged (once) and the link credited with the chat (once per
     * contact, first link wins).
     */
    async attribute(channelId: string, conversationId: string, text: string | null): Promise<void> {
        const code = referenceIn(text);
        if (!code) return;
        try {
            const link = await this.prisma.growthLink.findFirst({ where: { code, channelId, archivedAt: null } });
            if (!link) return;
            const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
            if (!conversation) return;
            const contact = conversation.contact;
            const attrs = (contact.attributes ?? {}) as Record<string, unknown>;
            const firstLink = typeof attrs.first_link === 'string' ? attrs.first_link : null;
            const tag = link.tag && !contact.tags.some((t) => t.toLowerCase() === link.tag!.toLowerCase()) ? link.tag : null;
            if (firstLink && !tag) return;
            const eventIds = await this.prisma.$transaction(async (tx) => {
                await tx.channelContact.update({
                    where: { id: contact.id },
                    data: {
                        ...(firstLink ? {} : { attributes: { ...attrs, first_link: link.name } as Prisma.InputJsonValue }),
                        ...(tag ? { tags: [...contact.tags, tag] } : {}),
                    },
                });
                if (!firstLink) await tx.growthLink.update({ where: { id: link.id }, data: { chats: { increment: 1 } } });
                return tag ? this.automationEvents.recordTagsAdded(tx, contact, [tag]) : [];
            });
            for (const id of eventIds) await this.jobs.event(id);
        } catch (err) {
            this.logger.warn(`Chat link ${code} not attributed: ${err instanceof Error ? err.message : err}`);
        }
    }

    // ─── Website button and pop-up ─────────────────────────────────────

    async widget(orgId: string) {
        const row = await this.prisma.siteWidget.findUnique({ where: { organizationId: orgId } });
        const link = row?.buttonLinkId ? await this.prisma.growthLink.findUnique({ where: { id: row.buttonLinkId } }) : null;
        return {
            configured: !!row,
            enabled: row?.enabled ?? false,
            channelId: row?.channelId ?? null,
            settings: parseWidgetSettings(row?.settings),
            allowedDomains: row?.allowedDomains ?? [],
            scriptUrl: row ? `${this.api}/widget/${row.key}.js` : null,
            stats: { clicks: link?.clicks ?? 0, chats: link?.chats ?? 0, popupViews: row?.popupViews ?? 0, signups: row?.signups ?? 0 },
        };
    }

    async saveWidget(orgId: string, userId: string, input: { channelId: string; enabled: boolean; settings: WidgetSettings; allowedDomains: string[] }) {
        const channel = await this.chatChannel(orgId, input.channelId);
        if (channel.platform !== ChannelPlatform.WHATSAPP) throw new BadRequestException('The website button opens a WhatsApp chat; choose a WhatsApp number.');
        const domains = [...new Set(input.allowedDomains.map(normalizeDomain))];
        if (domains.some((d) => !d)) throw new BadRequestException('Enter each website as a domain, like shop.example.com.');
        if (input.settings.popup.enabled && !domains.length) throw new BadRequestException('Add the website the pop-up runs on, so sign-ups from other sites are refused.');
        const existing = await this.prisma.siteWidget.findUnique({ where: { organizationId: orgId } });

        // The button's chat link: the same click and chat counting as any link.
        let buttonLinkId = existing?.buttonLinkId ?? null;
        if (buttonLinkId) {
            await this.prisma.growthLink.update({ where: { id: buttonLinkId }, data: { channelId: channel.id, prefilledText: input.settings.button.prefilledText || null, archivedAt: null } });
        } else {
            buttonLinkId = (await this.createLink(orgId, userId, { channelId: channel.id, name: BUTTON_LINK_NAME, prefilledText: input.settings.button.prefilledText, tag: 'website-chat' })).id;
        }
        const data = {
            channelId: channel.id,
            enabled: input.enabled,
            settings: input.settings as unknown as Prisma.InputJsonValue,
            allowedDomains: domains as string[],
            buttonLinkId,
        };
        if (existing) await this.prisma.siteWidget.update({ where: { id: existing.id }, data });
        else await this.prisma.siteWidget.create({ data: { ...data, organizationId: orgId, key: randomBytes(12).toString('base64url') } });
        return this.widget(orgId);
    }

    /** GET /widget/:key.js. A turned-off widget is an empty script, so a forgotten tag does nothing. */
    async script(key: string): Promise<string> {
        const row = await this.prisma.siteWidget.findUnique({ where: { key }, include: { organization: { select: { name: true } } } });
        if (!row?.enabled) return '/* Collabo chat widget is turned off */\n';
        const link = row.buttonLinkId ? await this.prisma.growthLink.findUnique({ where: { id: row.buttonLinkId } }) : null;
        return widgetScript({
            key: row.key,
            api: this.api,
            chatUrl: link && !link.archivedAt ? this.shortUrl(link.code) : null,
            storeName: row.organization.name,
            settings: parseWidgetSettings(row.settings),
        });
    }

    /** Beacons from the widget; only the pop-up's views are counted, never who viewed it. */
    async widgetEvent(key: string, type: string): Promise<void> {
        if (type !== 'popup_view') return;
        await this.prisma.siteWidget.updateMany({ where: { key, enabled: true }, data: { popupViews: { increment: 1 } } });
    }

    /**
     * A number from the pop-up, with the visitor's explicit consent. Only
     * from the merchant's own sites (Origin/Referer), and a filled honeypot
     * is answered as if it worked. Neither proves who typed the number, so
     * by default the sign-up waits for the person to confirm it on WhatsApp:
     * the answer carries a wa.me link whose message holds the sign-up's code
     * (see confirmSignup). With confirming turned off, the contact is opted
     * in at once with the pop-up's consent text as evidence, tagged, and
     * "Someone signs up on your website" automations start (they must send a
     * template: the person has not written); a contact who opted out is then
     * not opted back in: they do that by writing START.
     */
    async signup(
        key: string,
        input: { phone?: string; name?: string; consent?: string; page?: string; website?: string },
        origin: string | undefined,
    ): Promise<{ ok: true; confirmUrl?: string; code?: string }> {
        const widget = await this.prisma.siteWidget.findUnique({ where: { key }, include: { channel: { select: { id: true, organizationId: true, platform: true, status: true, credentials: true } } } });
        if (!widget?.enabled) throw new NotFoundException();
        const settings = parseWidgetSettings(widget.settings);
        if (!settings.popup.enabled) throw new NotFoundException();
        if (!hostAllowed(hostOf(origin), widget.allowedDomains)) throw new ForbiddenException('Sign-ups are accepted from the store’s own website only.');
        const confirm = settings.popup.confirmOnWhatsApp;
        // saveWidget refuses a number without a wa.me address.
        const confirmUrl = (code: string) => waMe(widget.channel.credentials, confirmationText(code)) ?? undefined;
        if (input.website) {
            const code = makeCode(SIGNUP_CODE_LENGTH);
            return confirm ? { ok: true, confirmUrl: confirmUrl(code), code } : { ok: true };
        }
        if (input.consent !== 'yes') throw new BadRequestException('Please tick the box to agree to messages on WhatsApp.');
        const e164 = normalizePhone(input.phone ?? null, null);
        const digits = e164?.replace(/\D/g, '') ?? '';
        if (!e164 || digits.length < 8 || digits.length > 15) throw new BadRequestException('Enter your WhatsApp number with its country code.');
        if (widget.channel.status !== ChannelStatus.CONNECTED) throw new BadRequestException('Sign-ups are paused right now. Please try again later.');
        const hourAgo = new Date(Date.now() - 3600_000);
        const lastHour = confirm
            ? await this.prisma.widgetSignup.count({ where: { organizationId: widget.organizationId, createdAt: { gt: hourAgo } } })
            : await this.prisma.consentEvent.count({ where: { organizationId: widget.organizationId, source: 'widget', occurredAt: { gt: hourAgo } } });
        if (lastHour >= SIGNUPS_PER_HOUR) {
            this.logger.warn(`Widget ${widget.id}: sign-up refused, ${lastHour} in the last hour`);
            throw new HttpException('Too many sign-ups right now. Please try again in a little while.', HttpStatus.TOO_MANY_REQUESTS);
        }
        const name = input.name?.trim().slice(0, 80) || null;
        const page = input.page?.slice(0, 500) ?? null;
        // The pop-up's own wording, never text the request brings.
        const consentText = settings.popup.consentText.slice(0, 300);

        if (confirm) {
            // No contact yet: the number may not be the visitor's.
            for (let attempt = 0; ; attempt++) {
                try {
                    const { code } = await this.prisma.widgetSignup.create({
                        data: {
                            organizationId: widget.organizationId,
                            widgetId: widget.id,
                            phone: digits,
                            name,
                            page,
                            consentText,
                            code: makeCode(SIGNUP_CODE_LENGTH),
                            expiresAt: new Date(Date.now() + CONFIRM_WITHIN_MS),
                        },
                        select: { code: true },
                    });
                    return { ok: true, confirmUrl: confirmUrl(code), code };
                } catch (err) {
                    if (!isUniqueViolation(err) || attempt > 3) throw err;
                }
            }
        }

        const signedUp = await this.prisma.$transaction(async (tx) => {
            const contact = await this.identity.resolve(tx, { id: widget.channel.id, organizationId: widget.organizationId }, { platform: ChannelPlatform.WHATSAPP, waId: digits, profileName: name }, { kind: 'none' });
            if (contact.optedOutAt) return null;
            return this.optInFromWidget(tx, widget.id, settings, contact, { page, consentText, widgetId: widget.id });
        });
        if (signedUp) await this.startSignupAutomations(widget.id, signedUp, { name, page });
        return { ok: true };
    }

    /**
     * An inbound WhatsApp text that may carry a pop-up sign-up's code.
     * Sending it proves the sender owns the number it came from, which may
     * not be the one typed: that contact is opted in with the sign-up's
     * evidence, tagged, and the sign-up's automations start, as without
     * confirming. The code works once. Asking in their own message is a
     * confirmed reply, so someone who had opted out is opted back in.
     */
    async confirmSignup(organizationId: string, conversationId: string, wamid: string, text: string | null): Promise<void> {
        const code = signupCodeIn(text);
        if (!code) return;
        try {
            const pending = await this.prisma.widgetSignup.findUnique({
                where: { organizationId_code: { organizationId, code } },
                include: { widget: { select: { id: true, settings: true } } },
            });
            if (!pending || pending.confirmedAt || pending.expiresAt <= new Date()) return;
            const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } });
            if (!conversation) return;
            const settings = parseWidgetSettings(pending.widget.settings);
            const signedUp = await this.prisma.$transaction(async (tx) => {
                // Two deliveries of the message may race; one confirms.
                const claimed = await tx.widgetSignup.updateMany({ where: { id: pending.id, confirmedAt: null }, data: { confirmedAt: new Date() } });
                if (!claimed.count) return null;
                const contact = await tx.channelContact.findUniqueOrThrow({ where: { id: conversation.contactId } });
                return this.optInFromWidget(tx, pending.widget.id, settings, contact, {
                    page: pending.page,
                    consentText: pending.consentText,
                    widgetId: pending.widget.id,
                    code,
                    wamid,
                    ...(contact.waId !== pending.phone ? { typedPhone: pending.phone } : {}),
                });
            });
            if (signedUp) await this.startSignupAutomations(pending.widget.id, signedUp, { name: pending.name, page: pending.page });
        } catch (err) {
            this.logger.warn(`Sign-up code ${code} not confirmed: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** Sign-ups past their confirmation window, confirmed or not; an opt-in keeps its evidence in consent_events. */
    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async pruneSignups(now = new Date()) {
        const { count } = await this.prisma.widgetSignup.deleteMany({ where: { expiresAt: { lt: now } } });
        if (count) this.logger.log(`Pruned ${count} expired pop-up sign-ups`);
        return count;
    }

    // ─── Internals ─────────────────────────────────────────────────────

    shortUrl(code: string): string {
        return `${this.api}/l/${code}`;
    }

    /**
     * The pop-up's opt-in, in the caller's transaction: consent with its
     * evidence, the customer link, the pop-up's tag and the sign-up count.
     * Null when the contact signed up within the day and is still opted in:
     * repeated sign-ups change nothing.
     */
    private async optInFromWidget(tx: Prisma.TransactionClient, widgetId: string, settings: WidgetSettings, contact: ChannelContact, evidence: Record<string, unknown>) {
        const recent = await tx.consentEvent.findFirst({ where: { contactId: contact.id, source: 'widget', occurredAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
        if (recent && !contact.optedOutAt) return null;
        await this.consent.record(tx, contact, ConsentType.OPT_IN, 'widget', evidence);
        const customerId = contact.customerId ?? (await this.identity.linkCustomerByPhone(tx, contact));
        const tag = settings.popup.tag && !contact.tags.some((t) => t.toLowerCase() === settings.popup.tag.toLowerCase()) ? settings.popup.tag : null;
        if (tag) await tx.channelContact.update({ where: { id: contact.id }, data: { tags: [...contact.tags, tag] } });
        await tx.siteWidget.update({ where: { id: widgetId }, data: { signups: { increment: 1 } } });
        const tagEvents = tag ? await this.automationEvents.recordTagsAdded(tx, contact, [tag]) : [];
        return { contact, customerId, tagEvents };
    }

    /** After the opt-in commits, so a duplicate (once a day per person) cannot undo it. */
    private async startSignupAutomations(
        widgetId: string,
        signedUp: { contact: ChannelContact; customerId: string | null; tagEvents: string[] },
        vars: { name: string | null; page: string | null },
    ) {
        const { contact } = signedUp;
        const signup = await this.prisma.automationEvent.create({
            data: {
                organizationId: contact.organizationId,
                channelId: contact.channelId,
                eventType: 'crm.website.signup',
                externalId: `${widgetId}:${contact.id}:${new Date().toISOString().slice(0, 10)}`,
                occurredAt: new Date(),
                contactId: contact.id,
                customerId: signedUp.customerId,
                actorExternalId: contact.externalId,
                payload: { raw: { vars: { 'signup.name': vars.name ?? '', 'signup.page': vars.page ?? '' } } } as Prisma.InputJsonValue,
            },
            select: { id: true },
        }).catch((err) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        for (const id of [...signedUp.tagEvents, ...(signup ? [signup.id] : [])]) await this.jobs.event(id);
    }

    private linkView(
        r: { id: string; name: string; code: string; prefilledText: string | null; tag: string | null; clicks: number; chats: number; lastClickAt: Date | null; createdAt: Date; channel: { id: string; name: string; platform: ChannelPlatform; credentials: unknown; externalStoreId: string | null; externalStoreUrl: string | null } },
        isWidgetButton: boolean,
    ) {
        return {
            id: r.id,
            name: r.name,
            code: r.code,
            shortUrl: this.shortUrl(r.code),
            target: chatTarget(r.channel, r.code, r.prefilledText),
            prefilledText: r.prefilledText,
            tag: r.tag,
            clicks: r.clicks,
            chats: r.chats,
            lastClickAt: r.lastClickAt,
            createdAt: r.createdAt,
            channel: { id: r.channel.id, name: r.channel.name, platform: r.channel.platform },
            isWidgetButton,
        };
    }

    private async link(orgId: string, id: string) {
        const link = await this.prisma.growthLink.findFirst({ where: { id, organizationId: orgId, archivedAt: null }, include: { channel: { select: { platform: true } } } });
        if (!link) throw new NotFoundException('Chat link not found');
        return link;
    }

    private async chatChannel(orgId: string, channelId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: { id: channelId, organizationId: orgId, platform: { in: CHAT_PLATFORMS } },
            select: { id: true, platform: true, credentials: true, externalStoreId: true, externalStoreUrl: true },
        });
        if (!channel) throw new NotFoundException('Channel not found');
        if (!chatTarget(channel, 'XXXXXXXX', null)) throw new BadRequestException('This account has no public address to link to yet. Reconnect it in Settings → Channels.');
        return channel;
    }
}
