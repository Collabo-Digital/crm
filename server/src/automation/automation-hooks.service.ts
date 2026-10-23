import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AutomationStatus, ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { storedPhoneIs } from '../messaging/contact-identity.service';

const MAX_FIELDS = 30;

/** Read `a.b.c` out of a JSON body. */
function pick(body: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), body);
}

/**
 * Another system starting an automation for one person: an order tool, a
 * form, a spreadsheet script. The secret URL is the credential; the body
 * names the person by phone number and its fields become {{webhook.*}}.
 */
@Injectable()
export class AutomationHooksService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly automationEvents: AutomationEventService,
        private readonly jobs: AutomationJobs,
    ) { }

    async receive(token: string, body: unknown, idempotencyKey: string | undefined) {
        const trigger = await this.prisma.automationTrigger.findFirst({
            where: { triggerType: 'crm.webhook', subjectId: token, isActive: true, automation: { status: AutomationStatus.ACTIVE } },
            include: { automation: { select: { id: true, organizationId: true, channelId: true } }, channel: { select: { id: true, platform: true } } },
        });
        if (!trigger || !trigger.channel) throw new NotFoundException('No active automation at this address.');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send a JSON object.');

        const phoneField = ((trigger.config ?? {}) as { phoneField?: string }).phoneField || 'phone';
        // 00 is the international prefix; a number that still starts with 0 has no country code.
        const digits = String(pick(body, phoneField) ?? '').replace(/\D/g, '').replace(/^00/, '');
        if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) {
            throw new BadRequestException(`Send "${phoneField}" as a full phone number with its country code, like +919876543210.`);
        }

        const contact = await this.contactFor(trigger.automation.organizationId, trigger.channel, digits);
        const fields = Object.fromEntries(
            Object.entries(body as Record<string, unknown>)
                .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
                .slice(0, MAX_FIELDS)
                .map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 500)]),
        );

        let eventId: string;
        try {
            const event = await this.automationEvents.record(this.prisma, {
                organizationId: trigger.automation.organizationId,
                channelId: trigger.channel.id,
                eventType: 'crm.webhook',
                externalId: `${trigger.automation.id}:${idempotencyKey?.slice(0, 100) || randomUUID()}`,
                occurredAt: new Date(),
                contactId: contact.id,
                actorExternalId: contact.externalId,
                payload: { automationId: trigger.automation.id, fields },
            });
            eventId = event.id;
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { accepted: true, duplicate: true };
            throw err;
        }
        await this.jobs.event(eventId);
        return { accepted: true };
    }

    /**
     * A contact with exactly this number always wins. WhatsApp can message
     * any number, so a new one becomes a contact. Instagram and Messenger
     * cannot: the person must be the one contact linked to a store customer
     * with this number (storedPhoneIs).
     */
    private async contactFor(orgId: string, channel: { id: string; platform: ChannelPlatform }, digits: string) {
        const existing = await this.prisma.channelContact.findFirst({
            where: { channelId: channel.id, OR: [{ waId: digits }, { externalId: digits }, { phone: `+${digits}` }] },
            select: { id: true, externalId: true },
        });
        if (existing) return existing;
        if (channel.platform !== ChannelPlatform.WHATSAPP) {
            const linked = await this.prisma.$queryRaw<Array<{ id: string; externalId: string }>>`
                SELECT cc."id", cc."external_id" AS "externalId"
                FROM "channel_contacts" cc
                JOIN "customers" c ON c."id" = cc."customer_id"
                WHERE cc."channel_id" = ${channel.id}
                  AND c."deleted_at" IS NULL
                  AND ${storedPhoneIs(Prisma.raw('c."phone"'), digits)}
                LIMIT 2
            `;
            if (linked.length === 1) return linked[0];
            throw new NotFoundException('Nobody with this phone number has messaged this account yet.');
        }
        try {
            return await this.prisma.channelContact.create({
                data: { organizationId: orgId, channelId: channel.id, platform: ChannelPlatform.WHATSAPP, externalId: digits, waId: digits, phone: `+${digits}` },
                select: { id: true, externalId: true },
            });
        } catch (err) {
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            return this.prisma.channelContact.findUniqueOrThrow({
                where: { channelId_externalId: { channelId: channel.id, externalId: digits } },
                select: { id: true, externalId: true },
            });
        }
    }
}
