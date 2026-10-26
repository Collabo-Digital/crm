import { opensThisApp, packFieldsFromName } from './pack-fields';

const APP = 'https://app.example.com';
const buttons = (...urls: string[]) => [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: urls.map((url) => ({ type: 'URL', text: 'Open', url })) }];

describe('which templates on the account are this app’s pack', () => {
    it('links to this app’s order, cart and bill pages, or Razorpay, are its own', () => {
        expect(opensThisApp(buttons(`${APP}/t/{{1}}`), APP)).toBe(true);
        expect(opensThisApp(buttons(`${APP}/c/{{1}}`), `${APP}/`)).toBe(true);
        expect(opensThisApp(buttons(`${APP}/b/{{1}}`), APP)).toBe(true);
        expect(opensThisApp(buttons('https://rzp.io/{{1}}'), APP)).toBe(true);
        expect(opensThisApp([{ type: 'BODY', text: 'No buttons' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirm order' }] }], APP)).toBe(true);
        expect(opensThisApp(undefined, APP)).toBe(true);
    });

    it('a link to another app, or anywhere else, is not', () => {
        expect(opensThisApp(buttons('https://preview.example.com/t/{{1}}'), APP)).toBe(false);
        expect(opensThisApp(buttons(`${APP}/t/{{1}}`, 'https://example.com/{{1}}'), APP)).toBe(false);
        expect(opensThisApp(buttons(`${APP}/settings/{{1}}`), APP)).toBe(false);
    });

    it('adopts a pack name in English that opens this app, from Meta’s library name when it has one', () => {
        expect(packFieldsFromName({ name: 'collabo_order_cancelled_v2', language: 'en', library_template_name: 'order_canceled_3', components: buttons(`${APP}/t/{{1}}`) }, APP))
            .toEqual({ packSlot: 'order_cancelled', packVersion: 2, packSource: 'library', libraryTemplateName: 'order_canceled_3' });
        expect(packFieldsFromName({ name: 'collabo_cart_reminder_1_v1', language: 'en', components: buttons(`${APP}/c/{{1}}`) }, APP))
            .toEqual({ packSlot: 'cart_reminder_1', packVersion: 1, packSource: 'collabo', libraryTemplateName: null });
    });

    it('leaves another app’s, another language’s, and names that are not the pack’s', () => {
        expect(packFieldsFromName({ name: 'collabo_order_shipped_v1', language: 'en', components: buttons('https://preview.example.com/t/{{1}}') }, APP)).toBeNull();
        expect(packFieldsFromName({ name: 'collabo_order_shipped_v1', language: 'hi', components: buttons(`${APP}/t/{{1}}`) }, APP)).toBeNull();
        expect(packFieldsFromName({ name: 'collabo_not_a_slot_v1', language: 'en' }, APP)).toBeNull();
        expect(packFieldsFromName({ name: 'order_shipped', language: 'en' }, APP)).toBeNull();
    });
});
