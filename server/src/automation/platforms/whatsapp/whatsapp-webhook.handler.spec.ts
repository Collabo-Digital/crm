import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import { accountUpdateEffect, channelChange } from './whatsapp-account-update.util';
import { WhatsAppWebhookHandler } from './whatsapp-webhook.handler';
import { parseWhatsAppDelivery } from './whatsapp-webhook.parser';

/**
 * Account events onto the channel: a restriction's details are kept for the
 * recommended template pack (which stops while utility templates are
 * restricted), with the channel's status, error copy and event record as
 * before; and template events reach TemplatesService with when Meta sent them.
 */

const WABA = '102290129340398';
const CHANNEL = {
    id: 'ch_wa',
    organizationId: 'org_1',
    externalStoreId: WABA,
    credentials: { phoneNumberId: '106540352242922' },
    status: ChannelStatus.CONNECTED as ChannelStatus,
    connectedAt: new Date('2026-01-01T00:00:00Z') as Date | null,
};

function build(current: { status: ChannelStatus; lastError: string | null } = { status: ChannelStatus.CONNECTED, lastError: null }) {
    const sql: Prisma.Sql[] = [];
    const prisma = {
        channel: {
            findMany: jest.fn(async () => [CHANNEL]),
            findUnique: jest.fn(async () => current),
            update: jest.fn(async () => ({})),
        },
        $executeRaw: jest.fn(async (q: Prisma.Sql) => (sql.push(q), 1)),
    };
    const templates = { applyWebhook: jest.fn(async () => undefined) };
    const handler = new WhatsAppWebhookHandler(prisma as never, {} as never, templates as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    jest.spyOn(handler['logger'], 'log').mockImplementation(() => undefined);
    /** The metadata keys written, with the JSON each statement carries. */
    const writes = () => sql.map((q) => ({ key: q.values.find((v) => typeof v === 'string' && /^(accountEvents|accountRestrictions|coexistence)$/.test(v)), sql: q.sql, values: q.values }));
    return { handler, prisma, templates, writes };
}

const accountUpdate = (value: Record<string, unknown>) =>
    parseWhatsAppDelivery({ object: 'whatsapp_business_account', entry: [{ id: WABA, time: 1751247700, changes: [{ field: 'account_update', value }] }] });

const utility = { restriction_type: 'RESTRICTED_UTILITY_TEMPLATES', expiration: 1751852500 };
const outbound = { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1751852500 };

describe('WhatsAppWebhookHandler: account restrictions', () => {
    it('keeps Meta’s restriction_info as it came, under metadata.accountRestrictions', async () => {
        const { handler, writes } = build();
        await handler.handle(accountUpdate({ event: 'ACCOUNT_RESTRICTION', restriction_info: [utility, outbound] }));
        const set = writes().find((w) => w.key === 'accountRestrictions')!;
        // The whole key is replaced, so a shorter list is not merged into the old one.
        expect(set.sql).toMatch(/jsonb_set\(coalesce\("metadata", '\{\}'::jsonb\), ARRAY\[\?\]::text\[\], \?::jsonb\)/);
        expect(set.values).toEqual(['accountRestrictions', JSON.stringify([utility, outbound]), 'ch_wa']);
    });

    it('empties the list when Meta lifts the restrictions', async () => {
        const { handler, writes } = build({ status: ChannelStatus.CONNECTED, lastError: 'Meta restricted this WhatsApp account. Open WhatsApp Manager to see what is limited.' });
        await handler.handle(accountUpdate({ event: 'ACCOUNT_RESTRICTION', restriction_info: [] }));
        expect(writes().find((w) => w.key === 'accountRestrictions')!.values).toEqual(['accountRestrictions', '[]', 'ch_wa']);
    });

    it('leaves the list alone for every other account event', async () => {
        const { handler, writes } = build();
        await handler.handle(accountUpdate({ event: 'PARTNER_REMOVED', disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } }));
        await handler.handle(accountUpdate({ event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SCAM' } }));
        expect(writes().map((w) => w.key)).not.toContain('accountRestrictions');
    });

    it.each([
        ['a restriction', { event: 'ACCOUNT_RESTRICTION', restriction_info: [outbound] }, { status: ChannelStatus.CONNECTED, lastError: null }],
        ['a lifted restriction', { event: 'ACCOUNT_RESTRICTION', restriction_info: [] }, { status: ChannelStatus.ERROR, lastError: 'Meta restricted this WhatsApp account. Open WhatsApp Manager to see what is limited.' }],
        ['a partner removal', { event: 'PARTNER_REMOVED', disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } }, { status: ChannelStatus.CONNECTED, lastError: null }],
    ])('keeps the channel’s status, error copy and event record as before for %s', async (_label, value, current) => {
        const { handler, prisma, writes } = build(current as { status: ChannelStatus; lastError: string | null });
        await handler.handle(accountUpdate(value));
        const [event] = accountUpdate(value) as Array<{ event: string | null; reason: string | null; value: Record<string, unknown> }>;
        const expected = channelChange(current as { status: ChannelStatus; lastError: string | null }, accountUpdateEffect(event.event, event.reason, event.value)!);
        if (Object.keys(expected).length) expect(prisma.channel.update).toHaveBeenCalledWith({ where: { id: 'ch_wa' }, data: expected });
        else expect(prisma.channel.update).not.toHaveBeenCalled();
        const recorded = writes().find((w) => w.key === 'accountEvents')!;
        expect(JSON.parse(recorded.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string)).toEqual({
            [value.event]: { at: expect.any(String), reason: event.reason, initiatedBy: (value as { disconnection_info?: { initiated_by?: string } }).disconnection_info?.initiated_by ?? null },
        });
    });
});

const templateApproved = () =>
    parseWhatsAppDelivery({
        object: 'whatsapp_business_account',
        entry: [{ id: WABA, time: 1751247548, changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 991, message_template_name: 'collabo_order_shipped_v1', message_template_language: 'en' } }] }],
    });

describe('WhatsAppWebhookHandler: template events', () => {
    it('passes when Meta sent the event on to TemplatesService', async () => {
        const { handler, templates } = build();
        await handler.handle(templateApproved());
        expect(templates.applyWebhook).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'ch_wa', organizationId: 'org_1' }),
            expect.objectContaining({ templateId: '991', event: 'APPROVED', at: new Date(1751247548 * 1000) }),
        );
    });
});

describe('WhatsAppWebhookHandler: which workspace', () => {
    it('applies a WABA that several rows claim to one of them only: the connected row connected first', async () => {
        const { handler, prisma, templates } = build();
        jest.spyOn(handler['logger'], 'warn').mockImplementation(() => undefined);
        prisma.channel.findMany.mockResolvedValue([
            { ...CHANNEL, id: 'ch_later', organizationId: 'org_2', connectedAt: new Date('2026-10-01T00:00:00Z') },
            { ...CHANNEL, id: 'ch_errored', organizationId: 'org_3', status: ChannelStatus.ERROR, connectedAt: new Date('2025-01-01T00:00:00Z') },
            CHANNEL,
        ]);

        await handler.handle(templateApproved());

        expect(prisma.channel.findMany.mock.calls[0]).toEqual([
            expect.objectContaining({ where: { platform: ChannelPlatform.WHATSAPP, externalStoreId: WABA, status: { not: ChannelStatus.DISCONNECTED } } }),
        ]);
        expect(templates.applyWebhook).toHaveBeenCalledTimes(1);
        expect(templates.applyWebhook).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch_wa', organizationId: 'org_1' }), expect.anything());
    });
});
