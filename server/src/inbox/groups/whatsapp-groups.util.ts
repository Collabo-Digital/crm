import { MetaGraphError } from '../../channel/meta-graph.types';

export { GROUP_CONTACT_PREFIX, groupContactExternalId, groupIdOfContact } from '../../messaging/group-contact';

/**
 * WhatsApp groups (Cloud API Groups) — Meta's rules, as Collabo applies them.
 * From developers.facebook.com/documentation/business-messaging/whatsapp/groups:
 * Official Business Accounts only, never a number shared with the WhatsApp
 * Business app; at most 8 participants besides the business; people join by
 * invite link only; text, media and templates only (no interactive or
 * commerce messages, no reactions).
 */

export const GROUP_MAX_PARTICIPANTS = 8;
export const GROUP_SUBJECT_MAX = 128;
export const GROUP_DESCRIPTION_MAX = 2048;

/** Meta's group error codes (groups/error-codes), in words for the team. */
const GROUP_ERRORS: Record<number, string> = {
    131215: 'This number cannot run groups: Meta allows them only on Official Business Accounts (the blue tick) using the Cloud API.',
    131211: 'This number has reached Meta’s limit of groups.',
    131214: 'Meta has paused group creation on this number for a while, after many marketing messages sent in customer service windows.',
    131208: 'WhatsApp is limiting group requests from this number. Try again in a few minutes.',
    131204: 'A group can have at most 8 participants besides your business.',
    131207: 'WhatsApp has suspended this group.',
    131020: 'A group with only your business in it cannot be messaged.',
};

export function groupErrorMessage(err: unknown): string | null {
    if (!(err instanceof MetaGraphError)) return null;
    return (err.metaCode !== undefined && err.metaCode !== null && GROUP_ERRORS[err.metaCode]) || null;
}

/** "Riya Menon" or "+91 98111 00160", for notices in the group's chat. */
export function participantLabel(waId: string, name: string | null | undefined): string {
    return name?.trim() || `+${waId}`;
}
