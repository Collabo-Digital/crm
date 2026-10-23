import type { ChannelContact } from '@prisma/client';

/** How a contact is shown: the name the team gave, then the profile and address-book names, then a handle or number. */
export function contactName(c: Pick<ChannelContact, 'displayName' | 'addressBookName' | 'username' | 'phone' | 'externalId'>): string {
    return c.displayName ?? c.addressBookName ?? (c.username ? `@${c.username}` : null) ?? c.phone ?? c.externalId;
}
