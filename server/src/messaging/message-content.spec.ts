import { readFileSync } from 'fs';
import { join } from 'path';
import { MessageKind } from '@prisma/client';
import { parseWhatsAppDelivery } from '../automation/platforms/whatsapp/whatsapp-webhook.parser';
import { parseMessengerDelivery } from '../automation/platforms/messenger/messenger-webhook.parser';
import { messengerContent, previewOf, whatsAppContent } from './message-content';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/meta', name), 'utf8'));

describe('whatsAppContent', () => {
    const messages = parseWhatsAppDelivery(fixture('wa-inbound-messages.json')).flatMap((e) =>
        e.kind === 'message' ? [e.message] : [],
    );
    const byId = Object.fromEntries(messages.map((m) => [m.id, whatsAppContent(m)]));

    it('maps each WhatsApp type to a stored kind', () => {
        expect(byId['wamid.IMAGE0001'].kind).toBe(MessageKind.IMAGE);
        expect(byId['wamid.BUTTON0001'].kind).toBe(MessageKind.INTERACTIVE);
        expect(byId['wamid.QUICKREPLY0001'].kind).toBe(MessageKind.INTERACTIVE);
        expect(byId['wamid.LOCATION0001'].kind).toBe(MessageKind.LOCATION);
        expect(byId['wamid.ORDER0001'].kind).toBe(MessageKind.ORDER);
        expect(byId['wamid.UNSUPPORTED0001'].kind).toBe(MessageKind.UNSUPPORTED);
        expect(byId['wamid.REACTION0001'].kind).toBe(MessageKind.REACTION);
    });

    it('keeps the media id and direct url for download', () => {
        expect(byId['wamid.IMAGE0001'].media).toMatchObject({
            platformMediaId: '1003383421387256',
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256',
            mime: 'image/jpeg',
        });
    });

    it('marks a history media placeholder as media still to come', () => {
        const [chunk] = parseWhatsAppDelivery(fixture('wa-history-chunk.json'));
        if (chunk.kind !== 'history_chunk') throw new Error('expected a chunk');
        const placeholder = whatsAppContent(chunk.threads[0].messages[0]);
        expect(placeholder).toEqual({ kind: MessageKind.UNSUPPORTED, text: null, media: {} });
    });
});

describe('messengerContent', () => {
    it('maps text, attachments, story mentions and shared posts', () => {
        const fb = parseMessengerDelivery(fixture('fb-message.json')).flatMap((e) => (e.kind === 'message' ? [e.message] : []));
        expect(messengerContent(fb[0])).toEqual({ kind: MessageKind.TEXT, text: 'hello, world!', media: null });
        expect(messengerContent(fb[1])).toMatchObject({ kind: MessageKind.IMAGE, media: { url: 'https://scontent.example.invalid/img.jpg' } });

        const ig = parseMessengerDelivery(fixture('ig-dm.json')).flatMap((e) => (e.kind === 'message' ? [e.message] : []));
        const mention = messengerContent(ig[2]);
        expect(mention).toMatchObject({ kind: MessageKind.SYSTEM, text: 'Mentioned you in their story', media: { doNotStore: true } });

        expect(
            messengerContent({
                mid: 'm1', text: null, attachments: [{ type: 'ig_reel', url: 'https://ig/reel/1', title: null }],
                quickReplyPayload: null, replyToMid: null, replyToStory: null, referral: null,
                isDeleted: false, isUnsupported: false, raw: {},
            }),
        ).toEqual({ kind: MessageKind.SYSTEM, text: 'Shared ig reel: https://ig/reel/1', media: null });
    });
});

describe('previewOf', () => {
    it('labels media and trims long text', () => {
        expect(previewOf({ kind: MessageKind.IMAGE, text: 'This one', media: {} })).toBe('Photo: This one');
        expect(previewOf({ kind: MessageKind.AUDIO, text: null, media: { voice: true } })).toBe('Voice message');
        expect(previewOf({ kind: MessageKind.TEXT, text: 'a\n\nb', media: null })).toBe('a b');
        const long = previewOf({ kind: MessageKind.TEXT, text: 'x'.repeat(500), media: null });
        expect(long).toHaveLength(140);
        expect(long.endsWith('…')).toBe(true);
    });
});
