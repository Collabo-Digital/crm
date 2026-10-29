import { contactKey } from './contact-identity.service';
import { isOptInText, isOptOutText } from './consent.service';
import { ChannelPlatform } from '@prisma/client';

describe('opt-out keywords', () => {
    it('recognises a bare STOP in its common forms', () => {
        for (const text of ['STOP', 'stop', ' Stop. ', 'Unsubscribe', 'opt out', 'opt-out', 'Stop promotions']) {
            expect(isOptOutText(text)).toBe(true);
        }
    });

    it('does not fire on a sentence that merely contains the word', () => {
        for (const text of ['please stop by the store', "don't stop", 'stop the order', '', null]) {
            expect(isOptOutText(text)).toBe(false);
        }
    });

    it('recognises opting back in', () => {
        expect(isOptInText('START')).toBe(true);
        expect(isOptInText('start the order')).toBe(false);
    });
});

describe('contactKey', () => {
    it('files WhatsApp contacts by BSUID, falling back to the phone number', () => {
        expect(contactKey({ platform: ChannelPlatform.WHATSAPP, userId: 'IN.1', waId: '9198' })).toBe('IN.1');
        expect(contactKey({ platform: ChannelPlatform.WHATSAPP, waId: '9198' })).toBe('9198');
        expect(contactKey({ platform: ChannelPlatform.WHATSAPP })).toBeNull();
    });

    it('files Messenger and Instagram contacts by their scoped id', () => {
        expect(contactKey({ platform: ChannelPlatform.INSTAGRAM, scopedId: 'IGSID' })).toBe('IGSID');
        expect(contactKey({ platform: ChannelPlatform.FACEBOOK, userId: 'ignored' })).toBeNull();
    });
});
