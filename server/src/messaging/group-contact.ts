/** A WhatsApp group's chat is a contact whose external id is this prefix and Meta's group id. */
export const GROUP_CONTACT_PREFIX = 'group:';

export const groupContactExternalId = (groupId: string) => `${GROUP_CONTACT_PREFIX}${groupId}`;

export function groupIdOfContact(externalId: string): string | null {
    return externalId.startsWith(GROUP_CONTACT_PREFIX) ? externalId.slice(GROUP_CONTACT_PREFIX.length) : null;
}
