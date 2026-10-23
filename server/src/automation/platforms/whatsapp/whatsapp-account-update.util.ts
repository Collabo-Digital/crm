import { ChannelStatus } from '@prisma/client';

export interface AccountUpdateEffect {
    /** New channel status, or null to leave it. */
    status: ChannelStatus | null;
    /** What the merchant reads on the channel card. Null clears it. */
    lastError: string | null | undefined;
    /** Stored under metadata.coexistence. */
    coexistence?: { state: 'connected' | 'reconnecting' | 'disconnected'; reason: string | null };
    /** Sends must wait: the number is offboarded or the partner link is gone. */
    pauseSends: boolean;
}

const REASON_COPY: Record<string, string> = {
    PRIMARY_INACTIVITY:
        "The WhatsApp Business app on the business phone hasn't been opened for about two weeks, so Meta disconnected the number from Collabo. Open the app on the phone, then reconnect WhatsApp here.",
    COMPANION_INACTIVITY:
        'A linked device was inactive for about 30 days, so Meta disconnected the number from Collabo. Reconnect WhatsApp here.',
    ACCOUNT_DISCONNECTED:
        'The number was disconnected from the WhatsApp Business Platform, either from the phone or by Meta. Reconnect WhatsApp here.',
    BUSINESS_DOWNGRADE:
        'The number was registered on the regular WhatsApp app instead of WhatsApp Business, which removed it from Collabo. Move it back to WhatsApp Business and reconnect.',
    CHANGE_NUMBER: 'The business changed its WhatsApp number. Connect the new number here.',
    USER_RE_REGISTERED: 'The number was registered again on a new device. Reconnect WhatsApp here.',
};

/**
 * What one `account_update` event does to the channel. Pure, so the copy and
 * the state machine can be specced without a database.
 *
 * Coexistence numbers (WhatsApp Business app + Cloud API) are the main source
 * of these: Meta offboards them on a device change and reconnects them in the
 * background, and drops the partner link entirely when the phone app goes
 * unused for about 14 days.
 */
export function accountUpdateEffect(event: string | null, reason: string | null): AccountUpdateEffect | null {
    switch (event) {
        case 'PARTNER_REMOVED':
            return {
                status: ChannelStatus.ERROR,
                lastError: (reason && REASON_COPY[reason]) ?? 'Meta removed Collabo from this WhatsApp number. Reconnect WhatsApp here.',
                coexistence: { state: 'disconnected', reason },
                pauseSends: true,
            };
        case 'ACCOUNT_OFFBOARDED':
            return {
                status: ChannelStatus.ERROR,
                lastError:
                    'WhatsApp is moving this number to a new device. Sending is paused until Meta reconnects it, usually within minutes.',
                coexistence: { state: 'reconnecting', reason },
                pauseSends: true,
            };
        case 'ACCOUNT_RECONNECTED':
            return {
                status: ChannelStatus.CONNECTED,
                lastError: null,
                coexistence: { state: 'connected', reason: null },
                pauseSends: false,
            };
        case 'ACCOUNT_DELETED':
            return {
                status: ChannelStatus.ERROR,
                lastError: 'This WhatsApp account was deleted on Meta’s side. Connect a number again.',
                pauseSends: true,
            };
        case 'DISABLED_UPDATE':
        case 'ACCOUNT_VIOLATION':
        case 'ACCOUNT_RESTRICTION':
            return {
                status: ChannelStatus.ERROR,
                lastError:
                    'Meta restricted this WhatsApp account. Open WhatsApp Manager to see the reason and request a review.',
                pauseSends: false,
            };
        default:
            return null;
    }
}
