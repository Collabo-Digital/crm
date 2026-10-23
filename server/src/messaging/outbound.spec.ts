import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { buildMessengerBody, buildWhatsAppBody, checkSend, replyWindow, type GateInput } from './outbound';

const now = new Date('2026-10-23T12:00:00Z');
const hoursBefore = (h: number) => new Date(now.getTime() - h * 3600_000);

function gate(overrides: Partial<GateInput> & Pick<GateInput, 'platform' | 'payload'>) {
    return checkSend({
        origin: 'agent',
        channel: { status: ChannelStatus.CONNECTED, isEnabled: true, sendsPaused: false },
        contact: { blockedAt: null, optedOutAt: null },
        window: replyWindow(overrides.platform, hoursBefore(2), now),
        now,
        ...overrides,
    });
}

describe('replyWindow', () => {
    it('is open for 24 hours after the last customer message', () => {
        expect(replyWindow(ChannelPlatform.WHATSAPP, hoursBefore(23), now).open).toBe(true);
        expect(replyWindow(ChannelPlatform.WHATSAPP, hoursBefore(25), now).open).toBe(false);
        expect(replyWindow(ChannelPlatform.WHATSAPP, null, now)).toEqual({ open: false, closesAt: null, humanAgentUntil: null });
    });

    it('gives Messenger and Instagram a 7-day human-agent extension, not WhatsApp', () => {
        expect(replyWindow(ChannelPlatform.INSTAGRAM, hoursBefore(30), now).humanAgentUntil?.toISOString()).toBe(
            new Date(hoursBefore(30).getTime() + 7 * 24 * 3600_000).toISOString(),
        );
        expect(replyWindow(ChannelPlatform.WHATSAPP, hoursBefore(30), now).humanAgentUntil).toBeNull();
    });
});

describe('checkSend', () => {
    const text = { type: 'text' as const, text: 'Hi' };

    it('allows a reply inside the window', () => {
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: text })).toEqual({ ok: true, humanAgentTag: false });
    });

    it('requires a template once the WhatsApp window closed, saying when it closed', () => {
        const res = gate({ platform: ChannelPlatform.WHATSAPP, payload: text, window: replyWindow(ChannelPlatform.WHATSAPP, hoursBefore(30), now) });
        expect(res).toMatchObject({ ok: false, code: 'window_closed' });
        expect(!res.ok && res.message).toMatch(/closed 6 hours ago.*template/);
        expect(
            gate({
                platform: ChannelPlatform.WHATSAPP,
                payload: { type: 'template', name: 'order_update', language: 'en', category: 'UTILITY' },
                window: replyWindow(ChannelPlatform.WHATSAPP, null, now),
            }),
        ).toEqual({ ok: true, humanAgentTag: false });
    });

    it('lets a person, but not an automation, reply on Instagram within 7 days using the HUMAN_AGENT tag', () => {
        const window = replyWindow(ChannelPlatform.INSTAGRAM, hoursBefore(48), now);
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: text, window })).toEqual({ ok: true, humanAgentTag: true });
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: text, window, origin: 'automation' })).toMatchObject({
            ok: false,
            code: 'window_closed',
        });
        const stale = replyWindow(ChannelPlatform.INSTAGRAM, hoursBefore(8 * 24), now);
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: text, window: stale })).toMatchObject({ ok: false });
    });

    it('refuses marketing templates to opted-out contacts but not utility ones', () => {
        const contact = { blockedAt: null, optedOutAt: hoursBefore(100) };
        expect(
            gate({ platform: ChannelPlatform.WHATSAPP, contact, payload: { type: 'template', name: 'sale', language: 'en', category: 'MARKETING' } }),
        ).toMatchObject({ ok: false, code: 'opted_out' });
        expect(
            gate({ platform: ChannelPlatform.WHATSAPP, contact, payload: { type: 'template', name: 'shipped', language: 'en', category: 'UTILITY' } }),
        ).toMatchObject({ ok: true });
    });

    it('refuses while the channel is disconnected or a coexistence number is reconnecting', () => {
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: text, channel: { status: ChannelStatus.ERROR, isEnabled: true, sendsPaused: false } })).toMatchObject({ code: 'channel_unavailable' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: text, channel: { status: ChannelStatus.CONNECTED, isEnabled: true, sendsPaused: true } })).toMatchObject({ code: 'channel_unavailable' });
    });

    it('lets a public comment reply go out whatever the window, on Instagram and Facebook only', () => {
        const reply = { type: 'comment_reply' as const, commentId: '17858893269000001', text: 'Sent you a DM!' };
        const closed = replyWindow(ChannelPlatform.INSTAGRAM, hoursBefore(24 * 30), now);
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: reply, window: closed })).toEqual({ ok: true, humanAgentTag: false });
        expect(gate({ platform: ChannelPlatform.FACEBOOK, payload: reply, window: closed }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: reply })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
    });

    it('checks shapes per platform', () => {
        expect(gate({ platform: ChannelPlatform.FACEBOOK, payload: { type: 'template', name: 'x', language: 'en' } })).toMatchObject({ code: 'unsupported_on_platform' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'buttons', text: 'Pick', buttons: [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: `B${i}` })) } })).toMatchObject({ code: 'invalid_payload' });
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: { type: 'text', text: '😀'.repeat(300) } })).toMatchObject({ code: 'invalid_payload' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'text', text: '  ' } })).toMatchObject({ code: 'invalid_payload' });
    });
});

describe('buildWhatsAppBody', () => {
    it('addresses the phone number when known, else the BSUID', () => {
        expect(buildWhatsAppBody({ type: 'text', text: 'Hi' }, { waId: '919845012345', userId: 'IN.1' })).toMatchObject({ to: '919845012345' });
        const bsuidOnly = buildWhatsAppBody({ type: 'text', text: 'Hi' }, { waId: null, userId: 'IN.1' });
        expect(bsuidOnly).toMatchObject({ recipient: 'IN.1' });
        expect(bsuidOnly).not.toHaveProperty('to');
    });

    it('builds reply buttons, a quoted reply and an uploaded document', () => {
        expect(
            buildWhatsAppBody(
                { type: 'buttons', text: 'Confirm your COD order?', buttons: [{ id: 'yes', title: 'Confirm' }, { id: 'no', title: 'Cancel' }] },
                { waId: '1', userId: null },
                { replyToExternalId: 'wamid.X' },
            ),
        ).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '1',
            context: { message_id: 'wamid.X' },
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: 'Confirm your COD order?' },
                action: { buttons: [{ type: 'reply', reply: { id: 'yes', title: 'Confirm' } }, { type: 'reply', reply: { id: 'no', title: 'Cancel' } }] },
            },
        });
        expect(
            buildWhatsAppBody(
                { type: 'media', mediaKind: 'document', storageKey: 'k', mime: 'application/pdf', filename: 'invoice.pdf', caption: 'Your invoice' },
                { waId: '1', userId: null },
                { mediaId: 'MEDIA1' },
            ),
        ).toMatchObject({ type: 'document', document: { id: 'MEDIA1', caption: 'Your invoice', filename: 'invoice.pdf' } });
    });
});

describe('buildMessengerBody', () => {
    it('tags a late human reply and builds quick replies', () => {
        expect(buildMessengerBody({ type: 'text', text: 'Sorry for the wait' }, 'PSID', { humanAgentTag: true })).toEqual({
            recipient: { id: 'PSID' },
            messaging_type: 'MESSAGE_TAG',
            tag: 'HUMAN_AGENT',
            message: { text: 'Sorry for the wait' },
        });
        expect(
            buildMessengerBody({ type: 'quick_replies', text: 'Size?', replies: [{ title: 'M', payload: 'SIZE_M' }] }, 'PSID'),
        ).toMatchObject({ messaging_type: 'RESPONSE', message: { quick_replies: [{ content_type: 'text', title: 'M', payload: 'SIZE_M' }] } });
    });

    it('sends a private reply to the comment, not the person', () => {
        expect(buildMessengerBody({ type: 'private_reply', commentId: 'C1', text: 'Sent you the price' }, 'unused')).toEqual({
            recipient: { comment_id: 'C1' },
            message: { text: 'Sent you the price' },
        });
    });
});
