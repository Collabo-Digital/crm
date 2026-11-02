import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { buildMessengerBody, buildWhatsAppBody, checkSend, outboundText, replyWindow, type GateInput } from './outbound';

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

    it('refuses a WebP picture on WhatsApp, which takes JPEG and PNG only', () => {
        const picture = (mime: string) => ({ type: 'media' as const, mediaKind: 'image' as const, storageKey: 'org1/a', mime });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: picture('image/webp') })).toMatchObject({ ok: false, code: 'invalid_payload' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: picture('image/jpeg') })).toEqual({ ok: true, humanAgentTag: false });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: picture('image/png') })).toEqual({ ok: true, humanAgentTag: false });
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

describe('catalog messages', () => {
    const list = {
        type: 'product_list' as const,
        catalogId: 'CAT1',
        header: 'New arrivals',
        text: 'Pick your favourites',
        sections: [{ title: 'Shirts', productRetailerIds: ['v1', 'v2'] }],
    };

    it('are WhatsApp only, at most 30 products, and never from a number shared with the Business app', () => {
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: list }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: list })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        const many = { ...list, sections: [{ title: 'All', productRetailerIds: Array.from({ length: 31 }, (_, i) => `v${i}`) }] };
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: many })).toMatchObject({ ok: false, code: 'invalid_payload' });
        expect(
            gate({
                platform: ChannelPlatform.WHATSAPP,
                payload: { type: 'product', catalogId: 'CAT1', productRetailerId: 'v1' },
                channel: { status: ChannelStatus.CONNECTED, isEnabled: true, sendsPaused: false, onBusinessApp: true },
            }),
        ).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
    });

    it('build Meta’s interactive product shapes', () => {
        const to = { waId: '919800000001', userId: null };
        expect(buildWhatsAppBody({ type: 'product', catalogId: 'CAT1', productRetailerId: 'v1', text: 'Here it is' }, to).interactive).toEqual({
            type: 'product',
            body: { text: 'Here it is' },
            action: { catalog_id: 'CAT1', product_retailer_id: 'v1' },
        });
        expect(buildWhatsAppBody(list, to).interactive).toEqual({
            type: 'product_list',
            header: { type: 'text', text: 'New arrivals' },
            body: { text: 'Pick your favourites' },
            action: { catalog_id: 'CAT1', sections: [{ title: 'Shirts', product_items: [{ product_retailer_id: 'v1' }, { product_retailer_id: 'v2' }] }] },
        });
        expect(buildWhatsAppBody({ type: 'catalog', text: 'Browse', thumbnailRetailerId: 'v2' }, to).interactive).toEqual({
            type: 'catalog_message',
            body: { text: 'Browse' },
            action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: 'v2' } },
        });
    });

    it('send 2 to 10 products as cards, with a message and nothing else (Meta: no header, footer or buttons)', () => {
        const carousel = { type: 'product_carousel' as const, catalogId: 'CAT1', text: 'Both sizes', productRetailerIds: ['v1', 'v2'] };
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: carousel }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { ...carousel, productRetailerIds: ['v1'] } })).toMatchObject({ ok: false, code: 'invalid_payload' });
        const eleven = Array.from({ length: 11 }, (_, i) => `v${i}`);
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { ...carousel, productRetailerIds: eleven } })).toMatchObject({ ok: false, code: 'invalid_payload' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { ...carousel, text: ' ' } })).toMatchObject({ ok: false, code: 'invalid_payload' });
        expect(gate({ platform: ChannelPlatform.FACEBOOK, payload: carousel })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(
            gate({ platform: ChannelPlatform.WHATSAPP, payload: carousel, channel: { status: ChannelStatus.CONNECTED, isEnabled: true, sendsPaused: false, onBusinessApp: true } }),
        ).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(buildWhatsAppBody(carousel, { waId: '919800000001', userId: null }).interactive).toEqual({
            type: 'carousel',
            body: { text: 'Both sizes' },
            action: {
                cards: [
                    { card_index: 0, type: 'product', action: { product_retailer_id: 'v1', catalog_id: 'CAT1' } },
                    { card_index: 1, type: 'product', action: { product_retailer_id: 'v2', catalog_id: 'CAT1' } },
                ],
            },
        });
        expect(outboundText(carousel)).toBe('Both sizes');
    });
});

describe('WhatsApp groups', () => {
    it('address the group, not a person', () => {
        expect(buildWhatsAppBody({ type: 'text', text: 'Hi all' }, { waId: null, userId: null, groupId: 'G1' })).toEqual({
            messaging_product: 'whatsapp',
            recipient_type: 'group',
            to: 'G1',
            type: 'text',
            text: { body: 'Hi all', preview_url: true },
        });
        expect(buildWhatsAppBody({ type: 'text', text: 'Hi' }, { waId: '919800000001', userId: null })).toMatchObject({ recipient_type: 'individual', to: '919800000001' });
    });

    it('take text, files and templates only, and nothing once the group is gone', () => {
        const open = { closed: null };
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'text', text: 'Hi all' }, group: open }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'template', name: 'drop_alert', language: 'en' }, group: open }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'buttons', text: 'Pick', buttons: [{ id: 'a', title: 'A' }] }, group: open })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'product', catalogId: 'CAT1', productRetailerId: 'v1' }, group: open })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'reaction', targetExternalId: 'wamid.1', emoji: '👍' }, group: open })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { type: 'text', text: 'Hi' }, group: { closed: 'This group no longer exists on WhatsApp.' } })).toMatchObject({
            ok: false,
            code: 'channel_unavailable',
            message: 'This group no longer exists on WhatsApp.',
        });
    });
});

describe('call permission requests', () => {
    const ask = { type: 'call_permission_request' as const, text: 'May we call you about your order?' };

    it('go as Meta’s interactive call_permission_request, WhatsApp only', () => {
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: ask }).ok).toBe(true);
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: ask })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(
            gate({ platform: ChannelPlatform.WHATSAPP, payload: ask, channel: { status: ChannelStatus.CONNECTED, isEnabled: true, sendsPaused: false, onBusinessApp: true } }),
        ).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: ask, group: { closed: null } })).toMatchObject({ ok: false, code: 'unsupported_on_platform' });
        expect(buildWhatsAppBody(ask, { waId: '919800000001', userId: null }).interactive).toEqual({
            type: 'call_permission_request',
            action: { name: 'call_permission_request' },
            body: { text: 'May we call you about your order?' },
        });
    });
});


describe('voice notes', () => {
    const note = { type: 'media' as const, mediaKind: 'audio' as const, storageKey: 'org1/n.ogg', mime: 'audio/ogg', voice: true, durationMs: 1500 };
    const to = { waId: '919800000001', userId: null };

    it('marks the WhatsApp audio as a voice message, and plain audio not', () => {
        expect(buildWhatsAppBody(note, to, { mediaId: 'MEDIA1' })).toMatchObject({ type: 'audio', audio: { id: 'MEDIA1', voice: true } });
        expect(buildWhatsAppBody({ ...note, voice: undefined }, to, { mediaId: 'MEDIA1' }).audio).toEqual({ id: 'MEDIA1' });
    });

    it('goes to Instagram and Messenger as an audio attachment', () => {
        expect(gate({ platform: ChannelPlatform.INSTAGRAM, payload: note })).toEqual({ ok: true, humanAgentTag: false });
        expect(gate({ platform: ChannelPlatform.FACEBOOK, payload: note })).toEqual({ ok: true, humanAgentTag: false });
        expect(buildMessengerBody(note, 'PSID1', { attachmentId: 'ATT1' }).message).toEqual({ attachment: { type: 'audio', payload: { attachment_id: 'ATT1' } } });
    });

    it('is refused where there is no audio to send it as', () => {
        expect(gate({ platform: ChannelPlatform.TIKTOK, payload: note })).toEqual({
            ok: false,
            code: 'unsupported_on_platform',
            message: 'Voice messages can be sent on WhatsApp, Instagram and Messenger only.',
        });
        expect(gate({ platform: ChannelPlatform.WHATSAPP, payload: { ...note, mediaKind: 'video' } })).toMatchObject({ ok: false, code: 'invalid_payload' });
    });
});
