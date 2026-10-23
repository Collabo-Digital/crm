import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWhatsAppDelivery, type WaEvent } from './whatsapp-webhook.parser';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(__dirname, '../../../../test/fixtures/meta', name), 'utf8'));

const ofKind = <K extends WaEvent['kind']>(events: WaEvent[], kind: K) =>
    events.filter((e): e is Extract<WaEvent, { kind: K }> => e.kind === kind);

describe('parseWhatsAppDelivery', () => {
    it('ignores deliveries for other objects', () => {
        expect(parseWhatsAppDelivery({ object: 'page', entry: [] })).toEqual([]);
        expect(parseWhatsAppDelivery(null)).toEqual([]);
    });

    describe('inbound messages', () => {
        const events = parseWhatsAppDelivery(fixture('wa-inbound-messages.json'));
        const messages = ofKind(events, 'message').map((e) => e.message);

        it('routes by account and phone number id', () => {
            expect(events[0]).toMatchObject({ wabaId: '102290129340398', phoneNumberId: '106540352242922' });
        });

        it('keeps the BSUID, phone number and profile name of the sender', () => {
            expect(messages[0].from).toEqual({
                userId: 'US.13491208655302741918',
                waId: '16505551234',
                username: null,
                profileName: 'Sheena Nelson',
            });
            expect(messages[0].to).toBeNull();
        });

        it('extracts readable text per message type', () => {
            const text = Object.fromEntries(messages.map((m) => [m.id, m.text]));
            expect(text['wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=']).toBe('Does it come in another color?');
            expect(text['wamid.IMAGE0001']).toBe('This one');
            expect(text['wamid.BUTTON0001']).toBe('Confirm');
            expect(text['wamid.LIST0001']).toBe('Priority Mail Express');
            expect(text['wamid.QUICKREPLY0001']).toBe('Stop promotions');
            expect(text['wamid.REACTION0001']).toBe('👍');
            expect(text['wamid.LOCATION0001']).toBe('MG Road');
            expect(text['wamid.ORDER0001']).toBe('Love these!');
            expect(text['wamid.UNSUPPORTED0001']).toBeNull();
        });

        it('keeps the replied-to message and the ad referral', () => {
            const button = messages.find((m) => m.id === 'wamid.BUTTON0001')!;
            expect(button.context).toEqual({ from: '15550783881', id: 'wamid.OUTBOUND0001' });
            const fromAd = messages.find((m) => m.id === 'wamid.REFERRAL0001')!;
            expect(fromAd.referral).toMatchObject({ source_type: 'ad', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ' });
        });

        it('carries message-level errors for unsupported types', () => {
            const unsupported = messages.find((m) => m.id === 'wamid.UNSUPPORTED0001')!;
            expect(unsupported.errors[0]).toMatchObject({ code: 131051, details: 'Message type is currently not supported.' });
        });

        it('parses second timestamps into dates', () => {
            expect(messages[0].timestamp.toISOString()).toBe('2025-06-08T20:59:43.000Z');
        });
    });

    it('handles a username adopter with no phone number at all', () => {
        const [event] = ofKind(parseWhatsAppDelivery(fixture('wa-inbound-username-user.json')), 'message');
        expect(event.message.from).toEqual({
            userId: 'US.99887766554433221100',
            waId: null,
            username: 'riya.k',
            profileName: 'Riya',
        });
    });

    it('surfaces a number change as a system message with both user ids', () => {
        const [event] = ofKind(parseWhatsAppDelivery(fixture('wa-system-number-change.json')), 'message');
        expect(event.message.type).toBe('system');
        expect(event.message.raw.system).toMatchObject({
            type: 'user_changed_number',
            wa_id: '12195555358',
            user_id: 'US.10000000000000000001',
            previous_user_id: 'US.13491208655302741918',
        });
    });

    it('reads statuses with pricing and failure reasons', () => {
        const statuses = ofKind(parseWhatsAppDelivery(fixture('wa-statuses.json')), 'status').map((e) => e.status);
        expect(statuses.map((s) => s.status)).toEqual(['sent', 'delivered', 'read', 'failed']);
        expect(statuses[1].pricing).toEqual({ type: 'regular', category: 'utility', billable: true });
        expect(statuses[0].pricing).toBeNull();
        expect(statuses[0].recipient.userId).toBe('US.13491208655302741918');
        expect(statuses[3].errors[0].code).toBe(131049);
    });

    it('reads phone-app echoes, including edits and deletions, as business-sent', () => {
        const echoes = ofKind(parseWhatsAppDelivery(fixture('wa-echo.json')), 'echo').map((e) => e.message);
        expect(echoes.map((m) => m.type)).toEqual(['text', 'edit', 'revoke']);
        expect(echoes[0].from).toBeNull();
        expect(echoes[0].to).toMatchObject({ waId: '16505551234', userId: 'US.13491208655302741918' });
        expect(echoes[1].text).toBe("Here's the corrected info");
        expect(echoes[2].raw.revoke).toEqual({ original_message_id: echoes[0].id });
    });

    describe('history', () => {
        it('reads a chunk with its phase, order and progress', () => {
            const [chunk] = ofKind(parseWhatsAppDelivery(fixture('wa-history-chunk.json')), 'history_chunk');
            expect(chunk).toMatchObject({ phase: 1, chunkOrder: 2, progress: 55 });
            const [thread] = chunk.threads;
            expect(thread.contact).toMatchObject({ waId: '16505551234', userId: 'US.13491208655302741918' });
            const [fromBusiness, fromUser] = thread.messages;
            expect(fromBusiness).toMatchObject({ type: 'media_placeholder', from: null, historyStatus: 'PLAYED' });
            expect(fromBusiness.to?.waId).toBe('16505551234');
            expect(fromUser).toMatchObject({ text: 'Thanks!', historyStatus: 'READ' });
            expect(fromUser.from?.waId).toBe('16505551234');
        });

        it('reads the follow-up media delivery keyed by the placeholder wamid', () => {
            const [media] = ofKind(parseWhatsAppDelivery(fixture('wa-history-media.json')), 'history_media');
            expect(media.messages[0]).toMatchObject({
                id: 'wamid.QyNUEHBgLMTY0NjcwNDM1OTUVAgARGBI1Rj3NEYxMzAzMzQ5MkEA',
                type: 'image',
                text: 'Black Prince echeveria',
            });
        });

        it('reports a business that declined to share history', () => {
            const [declined] = ofKind(parseWhatsAppDelivery(fixture('wa-history-declined.json')), 'history_declined');
            expect(declined.errors[0].code).toBe(2593109);
        });
    });

    it('reads synced phone-book contacts, adds and removes', () => {
        const [sync] = ofKind(parseWhatsAppDelivery(fixture('wa-contact-sync.json')), 'contact_sync');
        expect(sync.contacts).toHaveLength(2);
        expect(sync.contacts[0]).toMatchObject({
            action: 'add',
            fullName: 'Sheena Nelson',
            contact: { waId: '16505551234', userId: 'US.13491208655302741918' },
        });
        expect(sync.contacts[1].action).toBe('remove');
    });

    it('reads coexistence account lifecycle events', () => {
        const [removed] = ofKind(parseWhatsAppDelivery(fixture('wa-account-partner-removed.json')), 'account_update');
        expect(removed).toMatchObject({
            event: 'PARTNER_REMOVED',
            reason: 'PRIMARY_INACTIVITY',
            initiatedBy: 'SYSTEM',
            phoneNumber: '15550783881',
        });
        const [offboarded] = ofKind(parseWhatsAppDelivery(fixture('wa-account-offboarded.json')), 'account_update');
        expect(offboarded.event).toBe('ACCOUNT_OFFBOARDED');
        const [reconnected] = ofKind(parseWhatsAppDelivery(fixture('wa-account-reconnected.json')), 'account_update');
        expect(reconnected.event).toBe('ACCOUNT_RECONNECTED');
    });

    it('reads template status and quality updates', () => {
        const [status] = ofKind(parseWhatsAppDelivery(fixture('wa-template-status.json')), 'template_update');
        expect(status).toMatchObject({
            field: 'message_template_status_update',
            templateId: '1689556908129832',
            name: 'order_confirmation',
            language: 'en-US',
            event: 'APPROVED',
        });
        const [quality] = ofKind(parseWhatsAppDelivery(fixture('wa-template-quality.json')), 'template_update');
        expect(quality.event).toBe('YELLOW');
    });

    it('reads phone number quality updates', () => {
        const [update] = ofKind(parseWhatsAppDelivery(fixture('wa-phone-quality.json')), 'number_update');
        expect(update).toMatchObject({ field: 'phone_number_quality_update', event: 'UPGRADE' });
    });

    it('reads a marketing opt-out from user preferences', () => {
        const [pref] = ofKind(parseWhatsAppDelivery(fixture('wa-user-preferences.json')), 'user_preference');
        expect(pref).toMatchObject({ category: 'marketing_messages', value: 'stop' });
        expect(pref.contact.userId).toBe('US.13491208655302741918');
    });
});
