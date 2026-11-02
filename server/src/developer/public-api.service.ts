import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, ConsentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/phone.util';
import { ContactIdentityService } from '../messaging/contact-identity.service';
import { ConsentService } from '../messaging/consent.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { MessagingSendService } from '../messaging/send/messaging-send.service';
import type { OutboundPayload } from '../messaging/outbound';
import { ParamValue, renderTemplate, sendComponents, templateParams } from '../campaigns/templates/template-components';
import { TemplateDraftError } from '../campaigns/templates/template-components';
import type { ApiCaller } from './api-keys.service';
import { WebhooksService } from './webhooks.service';

export interface SendMessageInput {
    to: string;
    channelId?: string;
    text?: string;
    template?: { name: string; language?: string; values?: Record<string, string>; headerUrl?: string };
}

/**
 * /public/v1 for other systems (Zapier, the merchant's own tools): send a
 * WhatsApp message to a number, add or update a contact, look one up, list
 * the approved templates. Everything is scoped to the key's organization.
 */
@Injectable()
export class PublicApiService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly identity: ContactIdentityService,
        private readonly consent: ConsentService,
        private readonly automationEvents: AutomationEventService,
        private readonly jobs: AutomationJobs,
        private readonly sender: MessagingSendService,
        private readonly webhooks: WebhooksService,
    ) { }

    async me(caller: ApiCaller) {
        const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: caller.organizationId }, select: { id: true, name: true } });
        const key = await this.prisma.apiKey.findUniqueOrThrow({ where: { id: caller.keyId }, select: { name: true, scopes: true } });
        return { organization: org, key };
    }

    /**
     * A template (any time) or a text (within 24 hours of the person's last
     * message) to a WhatsApp number. Template values are keyed like the
     * template's variables: "1", "first_name", "button.0"; a media header is
     * a public https URL. An `Idempotency-Key` makes a retry send once.
     */
    async sendMessage(caller: ApiCaller, input: SendMessageInput, idempotencyKey?: string) {
        if (!!input.text === !!input.template) throw new BadRequestException('Send either `text` or `template`.');
        const channel = await this.whatsapp(caller.organizationId, input.channelId);
        const digits = this.digits(input.to);
        const contact = await this.prisma.$transaction((tx) => this.identity.resolve(tx, { id: channel.id, organizationId: caller.organizationId }, { platform: ChannelPlatform.WHATSAPP, waId: digits }, { kind: 'none' }));
        const conversationId = await this.sender.conversationFor(contact.id);
        const payload: OutboundPayload = input.text ? { type: 'text', text: input.text } : await this.templatePayload(caller.organizationId, channel.id, input.template!);
        const outcome = await this.sender.send({
            organizationId: caller.organizationId,
            conversationId,
            payload,
            origin: 'api',
            idempotencyKey: idempotencyKey ? `api:${caller.keyId}:${idempotencyKey.slice(0, 100)}` : null,
        });
        if (!outcome.ok) throw new UnprocessableEntityException({ message: outcome.message, code: outcome.code });
        return { message_id: outcome.messageId, conversation_id: conversationId, contact_id: contact.id, status: outcome.duplicate ? 'duplicate' : 'queued' };
    }

    /** Add or update a WhatsApp contact by number; new tags start "A contact gets a tag" automations. */
    async upsertContact(caller: ApiCaller, input: { phone: string; name?: string; channelId?: string; tags?: string[]; attributes?: Record<string, string>; optIn?: boolean; optInEvidence?: string }) {
        const channel = await this.whatsapp(caller.organizationId, input.channelId);
        const digits = this.digits(input.phone);
        const badKey = Object.keys(input.attributes ?? {}).find((k) => !/^[a-z0-9_]{1,40}$/.test(k));
        if (badKey) throw new BadRequestException(`Attribute names are lower-case letters, digits and _: “${badKey}” is not.`);
        const { contact, eventIds } = await this.prisma.$transaction(async (tx) => {
            let contact = await this.identity.resolve(tx, { id: channel.id, organizationId: caller.organizationId }, { platform: ChannelPlatform.WHATSAPP, waId: digits, profileName: input.name ?? null }, { kind: 'none' });
            const added = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].filter((t) => !contact.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
            contact = await tx.channelContact.update({
                where: { id: contact.id },
                data: {
                    ...(input.name ? { displayName: input.name.trim().slice(0, 120) } : {}),
                    ...(added.length ? { tags: [...contact.tags, ...added] } : {}),
                    ...(input.attributes ? { attributes: { ...((contact.attributes as Record<string, unknown>) ?? {}), ...input.attributes } as Prisma.InputJsonValue } : {}),
                },
            });
            if (input.optIn === true && !contact.optInAt) await this.consent.record(tx, contact, ConsentType.OPT_IN, 'api', { apiKeyId: caller.keyId, evidence: input.optInEvidence?.slice(0, 300) ?? null });
            if (input.optIn === false && !contact.optedOutAt) await this.consent.record(tx, contact, ConsentType.OPT_OUT, 'api', { apiKeyId: caller.keyId });
            if (!contact.customerId) await this.identity.linkCustomerByPhone(tx, contact);
            const eventIds = added.length ? await this.automationEvents.recordTagsAdded(tx, contact, added) : [];
            return { contact: await tx.channelContact.findUniqueOrThrow({ where: { id: contact.id } }), eventIds };
        });
        for (const id of eventIds) await this.jobs.event(id);
        return this.webhooks.contactView(contact);
    }

    async findContacts(caller: ApiCaller, phone: string | undefined) {
        if (!phone) throw new BadRequestException('Pass ?phone= with the number, country code included.');
        const digits = this.digits(phone);
        const rows = await this.prisma.channelContact.findMany({
            where: { organizationId: caller.organizationId, OR: [{ waId: digits }, { externalId: digits }, { phone: `+${digits}` }] },
            take: 10,
        });
        return rows.map((c) => this.webhooks.contactView(c));
    }

    async templates(caller: ApiCaller) {
        const rows = await this.prisma.messageTemplate.findMany({
            where: { organizationId: caller.organizationId, status: 'APPROVED' },
            orderBy: { name: 'asc' },
            select: { name: true, language: true, category: true, parameterFormat: true, components: true, channelId: true },
        });
        return rows.map((t) => ({
            name: t.name,
            language: t.language,
            category: t.category.toLowerCase(),
            channel_id: t.channelId,
            values: templateParams(t.components as Record<string, unknown>[], t.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL')
                .map((p) => ({ key: p.component === 'body' ? p.name : p.key, kind: p.kind, example: p.example ?? null })),
            preview: renderTemplate(t.components as Record<string, unknown>[]).body,
        }));
    }

    // ─── Internals ─────────────────────────────────────────────────────

    private async templatePayload(orgId: string, channelId: string, t: NonNullable<SendMessageInput['template']>): Promise<OutboundPayload> {
        const template = await this.prisma.messageTemplate.findFirst({
            where: { organizationId: orgId, channelId, name: t.name, status: 'APPROVED', ...(t.language ? { language: t.language } : {}) },
            orderBy: { updatedAt: 'desc' },
        });
        if (!template) throw new NotFoundException(`No approved template “${t.name}”${t.language ? ` in ${t.language}` : ''} on this number.`);
        const format = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = template.components as Record<string, unknown>[];
        const values: Record<string, ParamValue> = {};
        for (const [k, v] of Object.entries(t.values ?? {})) values[k.includes('.') || k === 'header' ? k : `body.${k}`] = String(v);
        const header = templateParams(components, format).find((p) => p.component === 'header' && p.kind !== 'text');
        if (header) {
            if (!t.headerUrl || !/^https:\/\//.test(t.headerUrl)) throw new BadRequestException(`“${t.name}” has a ${header.kind} header: pass its public https URL as template.headerUrl.`);
            values.header = { link: t.headerUrl };
        }
        try {
            return {
                type: 'template',
                name: template.name,
                language: template.language,
                category: template.category,
                components: sendComponents(components, format, values),
                previewText: renderTemplate(components, values).body,
            };
        } catch (err) {
            if (err instanceof TemplateDraftError) throw new BadRequestException(err.message);
            throw err;
        }
    }

    /** The given WhatsApp number of the organization, or its only connected one. */
    private async whatsapp(orgId: string, channelId?: string) {
        const numbers = await this.prisma.channel.findMany({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: ChannelStatus.CONNECTED, ...(channelId ? { id: channelId } : {}) },
            select: { id: true },
        });
        if (!numbers.length) throw new NotFoundException(channelId ? 'WhatsApp number not found' : 'Connect a WhatsApp number first.');
        if (numbers.length > 1) throw new BadRequestException('This organization has several WhatsApp numbers: pass channel_id.');
        return numbers[0];
    }

    private digits(phone: string): string {
        const e164 = normalizePhone(phone, null);
        const digits = e164?.replace(/\D/g, '') ?? '';
        if (digits.length < 8 || digits.length > 15) throw new BadRequestException('Use the full number with its country code, e.g. +919876543210.');
        return digits;
    }
}
