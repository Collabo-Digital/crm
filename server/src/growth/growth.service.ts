import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, ConsentType, Prisma } from '@prisma/client';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { ConsentService } from '../messaging/consent.service';
import { ContactIdentityService } from '../messaging/contact-identity.service';
import { normalizePhone } from '../common/phone.util';
import { WidgetSettings, chatTarget, hostAllowed, hostOf, makeCode, normalizeDomain, parseWidgetSettings, referenceIn } from './growth.util';
import { widgetScript } from './widget-script';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const CHAT_PLATFORMS: ChannelPlatform[] = [ChannelPlatform.WHATSAPP, ChannelPlatform.FACEBOOK, ChannelPlatform.INSTAGRAM];
const BUTTON_LINK_NAME = 'Website chat button';

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
     * is answered as if it worked. The contact is opted in with the consent
     * text as evidence, tagged, and "Someone signs up on your website"
     * automations start (they must send a template: the person has not
     * written).
     */
    async signup(key: string, input: { phone?: string; name?: string; consent?: string; consentText?: string; page?: string; website?: string }, origin: string | undefined): Promise<{ ok: true }> {
        const widget = await this.prisma.siteWidget.findUnique({ where: { key }, include: { channel: { select: { id: true, organizationId: true, platform: true, status: true } } } });
        if (!widget?.enabled) throw new NotFoundException();
        const settings = parseWidgetSettings(widget.settings);
        if (!settings.popup.enabled) throw new NotFoundException();
        if (!hostAllowed(hostOf(origin), widget.allowedDomains)) throw new ForbiddenException('Sign-ups are accepted from the store’s own website only.');
        if (input.website) return { ok: true };
        if (input.consent !== 'yes') throw new BadRequestException('Please tick the box to agree to messages on WhatsApp.');
        const e164 = normalizePhone(input.phone ?? null, null);
        const digits = e164?.replace(/\D/g, '') ?? '';
        if (!e164 || digits.length < 8 || digits.length > 15) throw new BadRequestException('Enter your WhatsApp number with its country code.');
        if (widget.channel.status !== ChannelStatus.CONNECTED) throw new BadRequestException('Sign-ups are paused right now. Please try again later.');
        const name = input.name?.trim().slice(0, 80) || null;
        const page = input.page?.slice(0, 500) ?? null;

        const result = await this.prisma.$transaction(async (tx) => {
            const contact = await this.identity.resolve(tx, { id: widget.channel.id, organizationId: widget.organizationId }, { platform: ChannelPlatform.WHATSAPP, waId: digits, profileName: name }, { kind: 'none' });
            // Repeated sign-ups within a day change nothing.
            const recent = await tx.consentEvent.findFirst({ where: { contactId: contact.id, source: 'widget', occurredAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
            if (recent) return null;
            await this.consent.record(tx, contact, ConsentType.OPT_IN, 'widget', { page, consentText: (input.consentText ?? settings.popup.consentText).slice(0, 300), widgetId: widget.id });
            const customerId = contact.customerId ?? (await this.identity.linkCustomerByPhone(tx, contact));
            const tag = settings.popup.tag && !contact.tags.some((t) => t.toLowerCase() === settings.popup.tag.toLowerCase()) ? settings.popup.tag : null;
            if (tag) await tx.channelContact.update({ where: { id: contact.id }, data: { tags: [...contact.tags, tag] } });
            await tx.siteWidget.update({ where: { id: widget.id }, data: { signups: { increment: 1 } } });
            const tagEvents = tag ? await this.automationEvents.recordTagsAdded(tx, contact, [tag]) : [];
            return { contact, customerId, tagEvents };
        });
        if (!result) return { ok: true };
        // After the commit: a duplicate here must not undo the sign-up.
        const signup = await this.prisma.automationEvent.create({
            data: {
                organizationId: widget.organizationId,
                channelId: widget.channel.id,
                eventType: 'crm.website.signup',
                externalId: `${widget.id}:${result.contact.id}:${new Date().toISOString().slice(0, 10)}`,
                occurredAt: new Date(),
                contactId: result.contact.id,
                customerId: result.customerId,
                actorExternalId: result.contact.externalId,
                payload: { raw: { vars: { 'signup.name': name ?? '', 'signup.page': page ?? '' } } } as Prisma.InputJsonValue,
            },
            select: { id: true },
        }).catch((err) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        for (const id of [...result.tagEvents, ...(signup ? [signup.id] : [])]) await this.jobs.event(id);
        return { ok: true };
    }

    // ─── Internals ─────────────────────────────────────────────────────

    shortUrl(code: string): string {
        return `${this.api}/l/${code}`;
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
