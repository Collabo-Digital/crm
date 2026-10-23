import { ChannelPlatform } from '@prisma/client';
import { CONVERSATIONS_STARTED, actionValue, adReferral, dayIn } from './ads.util';

describe('the ad a chat came from', () => {
    it('reads a click-to-WhatsApp referral, with its click id', () => {
        expect(adReferral(ChannelPlatform.WHATSAPP, {
            source_url: 'https://fb.me/abc', source_id: '120210000000001', source_type: 'ad', headline: 'Linen week', body: '20% off linen',
            media_type: 'image', image_url: 'https://scontent.example/ad.jpg', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ', welcome_message: { text: 'Hi!' },
        })).toEqual({ adId: '120210000000001', headline: 'Linen week', body: '20% off linen', sourceUrl: 'https://fb.me/abc', mediaUrl: 'https://scontent.example/ad.jpg', ctwaClid: 'ARAkLkA8rmlFeiCktEJQ', ref: null });
        // A Status ad has no click id; a post referral is not an ad.
        expect(adReferral(ChannelPlatform.WHATSAPP, { source_id: '120210000000002', source_type: 'ad' })?.ctwaClid).toBeNull();
        expect(adReferral(ChannelPlatform.WHATSAPP, { source_id: '999', source_type: 'post' })).toBeNull();
    });

    it('reads click-to-Messenger and click-to-Instagram referrals, and ignores m.me and ig.me links', () => {
        const ad = { ref: 'summer', ad_id: '120210000000003', source: 'ADS', type: 'OPEN_THREAD', ads_context_data: { ad_title: 'Summer edit', photo_url: 'https://scontent.example/p.jpg' } };
        expect(adReferral(ChannelPlatform.FACEBOOK, ad)).toEqual({ adId: '120210000000003', headline: 'Summer edit', body: null, sourceUrl: null, mediaUrl: 'https://scontent.example/p.jpg', ctwaClid: null, ref: 'summer' });
        expect(adReferral(ChannelPlatform.INSTAGRAM, ad)?.adId).toBe('120210000000003');
        expect(adReferral(ChannelPlatform.FACEBOOK, { ref: 'K7Q2M9XD', source: 'SHORTLINK', type: 'OPEN_THREAD' })).toBeNull();
        expect(adReferral(ChannelPlatform.FACEBOOK, null)).toBeNull();
    });

    it('reads Meta’s messaging results and days in the organization’s time zone', () => {
        expect(actionValue([{ action_type: 'link_click', value: '9' }, { action_type: CONVERSATIONS_STARTED, value: '42' }], CONVERSATIONS_STARTED)).toBe(42);
        expect(actionValue(undefined, CONVERSATIONS_STARTED)).toBe(0);
        expect(dayIn('Asia/Kolkata', new Date('2026-10-23T20:00:00Z'))).toBe('2026-10-24');
    });
});
