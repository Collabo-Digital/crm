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
    /** Meta lifted a restriction: clear what restrictions set, and nothing else (see channelChange). */
    lift?: boolean;
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

const DISABLED = 'Meta disabled this WhatsApp account, so nothing can be sent. Open WhatsApp Manager to see why and request a review.';

/**
 * Errors that stop sending and that only Meta's restrictions set, so a
 * reinstatement or a healthy health check may clear them. The second is the
 * copy older versions wrote for every restriction event.
 */
export const RESTRICTION_ERRORS = [
    DISABLED,
    'Meta restricted this WhatsApp account. Open WhatsApp Manager to see the reason and request a review.',
];

/// How every restriction or warning below begins, so lifting one never clears another kind of error.
const RESTRICTION_PREFIXES = [
    'Meta disabled this WhatsApp account',
    'Meta plans to disable this WhatsApp account',
    'Meta reported a policy violation',
    'Meta restricted this WhatsApp account',
    'Meta has stopped this',
];

export const isRestrictionCopy = (lastError: string | null): boolean =>
    !!lastError && RESTRICTION_PREFIXES.some((p) => lastError.startsWith(p));

const RESTRICTION_COPY: Record<string, (until: string) => string> = {
    RESTRICTED_BIZ_INITIATED_MESSAGING: (until) =>
        `Meta has stopped this number from starting conversations${until}: templates to customers who have not written in the last 24 hours will fail. Replies still work.`,
    RESTRICTED_CUSTOMER_INITIATED_MESSAGING: (until) =>
        `Meta has stopped this number from replying to customers${until}. Open WhatsApp Manager to see why.`,
    RESTRICTED_ADD_PHONE_NUMBER_ACTION: (until) => `Meta has stopped this account from adding phone numbers${until}.`,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const strings = (v: unknown): string[] => list(v).filter((s): s is string => typeof s === 'string');

function untilText(expiration: unknown): string {
    const seconds = Number(expiration);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    return ` until ${new Date(seconds * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`;
}

/**
 * The restrictions an ACCOUNT_RESTRICTION event says are on the account, as
 * Meta sent them (`restriction_info`: restriction_type, expiration), for
 * `metadata.accountRestrictions`; empty when Meta lifts them. Null for any
 * other event, which leaves the stored list alone. The recommended template
 * pack stops while one restricts utility templates.
 */
export function accountRestrictionsOf(event: string | null, value: Obj = {}): unknown[] | null {
    return event === 'ACCOUNT_RESTRICTION' ? list(value.restriction_info) : null;
}

/**
 * What one `account_update` event does to the channel. Pure, so the copy and
 * the state machine can be specced without a database. `value` is the
 * webhook's value object, for ban_info, violation_info and restriction_info.
 *
 * Coexistence numbers (WhatsApp Business app + Cloud API) are the main source
 * of these: Meta offboards them on a device change and reconnects them in the
 * background, and drops the partner link entirely when the phone app goes
 * unused for about 14 days.
 *
 * Only a disabled account stops sending here. Warnings and restrictions are
 * shown on the channel card; Meta refuses what they forbid, with a reason.
 */
export function accountUpdateEffect(event: string | null, reason: string | null, value: Obj = {}): AccountUpdateEffect | null {
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
        case 'DISABLED_UPDATE': {
            const states = strings(obj(value.ban_info)?.waba_ban_state);
            if (states.includes('REINSTATE')) return { status: ChannelStatus.CONNECTED, lastError: null, pauseSends: false, lift: true };
            if (states.includes('DISABLE')) return { status: ChannelStatus.ERROR, lastError: DISABLED, pauseSends: false };
            return {
                status: null,
                lastError: 'Meta plans to disable this WhatsApp account. Open WhatsApp Manager to see why and appeal before it happens.',
                pauseSends: false,
            };
        }
        case 'ACCOUNT_VIOLATION': {
            const type = obj(value.violation_info)?.violation_type;
            return {
                status: null,
                lastError: `Meta reported a policy violation on this WhatsApp account${typeof type === 'string' ? ` (${type.toLowerCase().replace(/_/g, ' ')})` : ''}. Open WhatsApp Manager to see the details.`,
                pauseSends: false,
            };
        }
        case 'ACCOUNT_RESTRICTION': {
            const restrictions = list(value.restriction_info).map(obj).filter((r): r is Obj => !!r);
            const copy = restrictions
                .map((r) => {
                    const type = typeof r.restriction_type === 'string' ? r.restriction_type : '';
                    return RESTRICTION_COPY[type]?.(untilText(r.expiration));
                })
                .filter((c): c is string => !!c);
            if (!restrictions.length) return { status: ChannelStatus.CONNECTED, lastError: null, pauseSends: false, lift: true };
            return {
                status: null,
                lastError: copy.length ? copy.join(' ') : 'Meta restricted this WhatsApp account. Open WhatsApp Manager to see what is limited.',
                pauseSends: false,
            };
        }
        default:
            return null;
    }
}

/**
 * The channel columns an effect changes, given what the channel shows now.
 * A warning never hides another problem (an unfinished setup, a revoked
 * token), and a lift clears only what restrictions set.
 */
export function channelChange(
    current: { status: ChannelStatus; lastError: string | null },
    effect: AccountUpdateEffect,
): { status?: ChannelStatus; lastError?: string | null } {
    if (effect.lift) {
        if (!isRestrictionCopy(current.lastError)) return {};
        return { lastError: null, ...(current.status === ChannelStatus.ERROR ? { status: ChannelStatus.CONNECTED } : {}) };
    }
    if (!effect.status) {
        return effect.lastError !== undefined && (!current.lastError || isRestrictionCopy(current.lastError)) ? { lastError: effect.lastError } : {};
    }
    return { status: effect.status, ...(effect.lastError !== undefined ? { lastError: effect.lastError } : {}) };
}

/**
 * The daily health check: Meta says the number can send, so an error that
 * only a restriction set is out of date.
 */
export function healthClearsRestriction(canSendMessage: string | undefined): boolean {
    return canSendMessage === 'AVAILABLE' || canSendMessage === 'LIMITED';
}
