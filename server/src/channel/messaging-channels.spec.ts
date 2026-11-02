import { ChannelPlatform } from '@prisma/client';

import { offeredMessagingChannels, requireMessagingChannel } from './messaging-channels';

describe('messaging channels on offer', () => {
    const saved = process.env.MESSAGING_CHANNELS;
    afterEach(() => {
        if (saved === undefined) delete process.env.MESSAGING_CHANNELS;
        else process.env.MESSAGING_CHANNELS = saved;
    });

    it('is WhatsApp only unless listed', () => {
        expect(offeredMessagingChannels(undefined)).toEqual([ChannelPlatform.WHATSAPP]);
        expect(offeredMessagingChannels(' whatsapp, Instagram ,BOGUS')).toEqual([ChannelPlatform.WHATSAPP, ChannelPlatform.INSTAGRAM]);
    });

    it('refuses connecting a channel that is not offered, in words', () => {
        delete process.env.MESSAGING_CHANNELS;
        expect(() => requireMessagingChannel(ChannelPlatform.INSTAGRAM)).toThrow('Instagram is not available yet.');
        expect(() => requireMessagingChannel(ChannelPlatform.FACEBOOK)).toThrow('Messenger is not available yet.');
        expect(() => requireMessagingChannel(ChannelPlatform.WHATSAPP)).not.toThrow();
        process.env.MESSAGING_CHANNELS = 'WHATSAPP,INSTAGRAM';
        expect(() => requireMessagingChannel(ChannelPlatform.INSTAGRAM)).not.toThrow();
    });
});
