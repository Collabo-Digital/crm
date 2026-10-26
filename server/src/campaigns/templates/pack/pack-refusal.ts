import { HttpException } from '@nestjs/common';
import { MetaGraphError } from '../../../channel/meta-graph.types';
import { isRateLimitedError } from '../../../rate-limit/rate-limit.types';

/**
 * What a failed template creation means for the pack. Meta documents the
 * duplicate name (code 100, subcode 2388024); the wording of its template
 * limits is not documented, so those are also matched on Meta's words,
 * and every refusal is logged in full by the caller.
 */
export type PackFailure =
    /** The name is taken at Meta: adopt that template, or move to the next version. */
    | { kind: 'name_taken' }
    /** Too many calls or too many templates created this hour: stop and try again in an hour. */
    | { kind: 'rate_limited' }
    /** The account holds as many templates as Meta allows: stop the pack. */
    | { kind: 'template_limit' }
    /** Meta no longer accepts Collabo's access to the account: stop the pack. */
    | { kind: 'auth' }
    /** Meta refused this template: try the slot's next variant. */
    | { kind: 'refused'; message: string }
    /** Did not get an answer (timeout, 5xx): the run stops and is retried, and the next run adopts what Meta made. */
    | { kind: 'transient' };

/** 2388024: "Content in This Language Already Exists". 2388023: the name is being deleted in this language (unverified). */
const NAME_TAKEN_SUBCODES = new Set([2388024, 2388023]);
/** Business-account call throttle (unverified for template creation; 4, 17, 32 and 613 arrive as RateLimitedError). */
const THROTTLE_CODES = new Set([80008]);

/** Every text Meta gave with a refusal. */
export function metaErrorText(err: MetaGraphError): string {
    const d = (err.details ?? {}) as { message?: string; error_user_title?: string; error_user_msg?: string; error_data?: { details?: string } | string };
    const data = typeof d.error_data === 'string' ? d.error_data : d.error_data?.details;
    return [err.message, d.message, d.error_user_title, d.error_user_msg, data].filter(Boolean).join(' | ');
}

const refusedByMeta = (err: unknown): err is MetaGraphError =>
    err instanceof MetaGraphError && (err.code === 'API_ERROR' || (err.code === 'HTTP_ERROR' && (err.httpStatus ?? 0) < 500));

export function classifyPackFailure(err: unknown): PackFailure {
    if (isRateLimitedError(err)) return { kind: 'rate_limited' };
    if (err instanceof MetaGraphError && err.code === 'AUTH_FAILED') return { kind: 'auth' };
    if (refusedByMeta(err)) {
        const text = metaErrorText(err);
        if ((err.subcode !== undefined && NAME_TAKEN_SUBCODES.has(err.subcode)) || /already exists/i.test(text)) return { kind: 'name_taken' };
        if ((err.metaCode !== undefined && THROTTLE_CODES.has(err.metaCode)) || /per hour|too many (calls|requests)|(creation|creating) (rate )?limit/i.test(text)) {
            return { kind: 'rate_limited' };
        }
        if (/template limit|maximum number of (message )?templates|too many (message )?templates|limit of \d+ (message )?templates/i.test(text)) {
            return { kind: 'template_limit' };
        }
        return { kind: 'refused', message: text };
    }
    // The create path's own checks (a draft Meta's rules refuse, no handle for the sample).
    if (err instanceof HttpException && err.getStatus() < 500) return { kind: 'refused', message: err.message };
    return { kind: 'transient' };
}

/** Meta refused `library_template_button_inputs` for its form (an array where it wants a JSON string, or the reverse). */
export function isButtonInputsRefusal(err: unknown): boolean {
    return refusedByMeta(err) && /library_template_button_inputs|button_inputs/i.test(metaErrorText(err));
}

/** Why a pack stopped, as the merchant reads it. */
export const PACK_STOPPED = {
    disconnected: 'WhatsApp is not connected. Reconnect it in Settings → Channels to finish setting up these templates.',
    restricted: 'Meta is restricting utility templates on this WhatsApp account, so no more templates are being created. Choose Repair once the restriction ends.',
    templateLimit: "This WhatsApp account has reached Meta's limit on message templates. Delete templates you no longer use, then choose Repair.",
    auth: "Meta no longer accepts Collabo's access to this WhatsApp account. Reconnect WhatsApp in Settings → Channels.",
};
