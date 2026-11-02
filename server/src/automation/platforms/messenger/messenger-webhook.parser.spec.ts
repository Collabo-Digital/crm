import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMessengerDelivery, type MsEvent } from './messenger-webhook.parser';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(__dirname, '../../../../test/fixtures/meta', name), 'utf8'));

const ofKind = <K extends MsEvent['kind']>(events: MsEvent[], kind: K) =>
    events.filter((e): e is Extract<MsEvent, { kind: K }> => e.kind === kind);

describe('parseMessengerDelivery', () => {
    it('ignores other objects', () => {
        expect(parseMessengerDelivery({ object: 'whatsapp_business_account', entry: [] })).toEqual([]);
    });

    describe('Facebook Page', () => {
        it('reads text, attachments, quick replies and quoted replies', () => {
            const messages = ofKind(parseMessengerDelivery(fixture('fb-message.json')), 'message');
            expect(messages).toHaveLength(3);
            expect(messages[0]).toMatchObject({
                platform: 'FACEBOOK',
                accountId: '682498302938465',
                senderId: '6783960784969421',
                standby: false,
            });
            expect(messages[0].message).toMatchObject({ mid: 'm_FBTEXT0001', text: 'hello, world!', quickReplyPayload: 'SIZE_M' });
            expect(messages[1].message.attachments).toEqual([
                { type: 'image', url: 'https://scontent.example.invalid/img.jpg', title: null },
            ]);
            expect(messages[2].message.replyToMid).toBe('m_FBOUT0001');
            expect(messages[0].timestamp.getTime()).toBe(1458692752478);
        });

        it('reads an echo from the Page inbox with the sending app id', () => {
            const [echo] = ofKind(parseMessengerDelivery(fixture('fb-echo.json')), 'echo');
            expect(echo).toMatchObject({ recipientId: '6783960784969421', appId: '263902037430900' });
            expect(echo.message.text).toBe('Replied from the Page inbox');
        });

        it('reads deliveries, reads and reactions', () => {
            const events = parseMessengerDelivery(fixture('fb-delivery-read-reaction.json'));
            const [delivery] = ofKind(events, 'delivery');
            expect(delivery.mids).toEqual(['m_FBOUT0001']);
            expect(delivery.watermark?.getTime()).toBe(1458668856253);
            const [read] = ofKind(events, 'read');
            expect(read.watermark?.getTime()).toBe(1458668856253);
            const [reaction] = ofKind(events, 'reaction');
            expect(reaction).toMatchObject({ mid: 'm_FBOUT0001', emoji: '❤️', action: 'react' });
        });

        it('reads a postback button press', () => {
            const [postback] = ofKind(parseMessengerDelivery(fixture('fb-postback.json')), 'postback');
            expect(postback).toMatchObject({ payload: 'TRACK_ORDER', title: 'Track my order' });
        });

        it('reads a Page post comment from the feed', () => {
            const [comment] = ofKind(parseMessengerDelivery(fixture('fb-feed-comment.json')), 'comment');
            expect(comment).toMatchObject({
                commentId: '682498302938465_1234567890_111',
                postId: '682498302938465_1234567890',
                text: 'price?',
                fromId: '7531592584',
                fromName: 'Arjun M',
                verb: 'add',
            });
            expect(comment.timestamp.toISOString()).toBe('2023-11-14T22:13:20.000Z');
        });

        it('flags standby events so nothing auto-replies to them', () => {
            const [standby] = ofKind(parseMessengerDelivery(fixture('fb-standby.json')), 'message');
            expect(standby.standby).toBe(true);
            expect(standby.message.text).toBe('answered by Meta AI');
        });
    });

    describe('Instagram', () => {
        it('reads DMs, story replies and story mentions', () => {
            const messages = ofKind(parseMessengerDelivery(fixture('ig-dm.json')), 'message');
            expect(messages.map((m) => m.platform)).toEqual(['INSTAGRAM', 'INSTAGRAM', 'INSTAGRAM']);
            expect(messages[0].message.text).toBe('Is this available?');
            expect(messages[1].message.replyToStory).toEqual({
                id: '17920000000000000',
                url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
            });
            expect(messages[2].message.attachments[0].type).toBe('story_mention');
        });

        it('reads an echo of a message the business sent', () => {
            const [echo] = ofKind(parseMessengerDelivery(fixture('ig-echo.json')), 'echo');
            expect(echo).toMatchObject({ recipientId: '1248732924982231', appId: null });
        });

        it('reads a comment on a reel', () => {
            const [comment] = ofKind(parseMessengerDelivery(fixture('ig-comment.json')), 'comment');
            expect(comment).toMatchObject({
                commentId: '17999999999999999',
                postId: '17866662222222222',
                text: 'PRICE please',
                fromId: '1248732924982231',
                fromName: 'riya.k',
                mediaProductType: 'REELS',
                parentId: null,
            });
        });

        it('reads a messaging event wrapped as a change, as the dashboard test sends it', () => {
            const [event] = parseMessengerDelivery({
                object: 'instagram',
                entry: [{
                    id: '17841405822304914',
                    time: 1700000000,
                    changes: [{
                        field: 'messages',
                        value: {
                            sender: { id: '12334' },
                            recipient: { id: '23245' },
                            timestamp: '1527459824',
                            message: { mid: 'random_mid', text: 'random_text' },
                        },
                    }],
                }],
            });
            expect(event).toMatchObject({ kind: 'message', senderId: '12334' });
            expect(event.timestamp.getTime()).toBe(1527459824000);
        });
    });
});
