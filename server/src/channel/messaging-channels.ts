import { ForbiddenException } from '@nestjs/common';
import { ChannelPlatform } from '@prisma/client';

const NAME: Partial<Record<ChannelPlatform, string>> = {
    [ChannelPlatform.INSTAGRAM]: 'Instagram',
    [ChannelPlatform.FACEBOOK]: 'Messenger',
    [ChannelPlatform.WHATSAPP]: 'WhatsApp',
};

/**
 * The messaging channels this deployment offers, from MESSAGING_CHANNELS (a
 * comma list; WhatsApp only when unset). The client hides the rest with
 * VITE_MESSAGING_CHANNELS; this refuses connecting them.
 */
export function offeredMessagingChannels(raw = process.env.MESSAGING_CHANNELS): ChannelPlatform[] {
    return (raw || 'WHATSAPP')
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter((p): p is ChannelPlatform => p in ChannelPlatform);
}

export function requireMessagingChannel(platform: ChannelPlatform): void {
    if (!offeredMessagingChannels().includes(platform)) {
        throw new ForbiddenException(`${NAME[platform] ?? platform} is not available yet.`);
    }
}
