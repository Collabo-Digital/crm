import { UserRole } from '@prisma/client';

/**
 * What an agent may hold and still be an ops seat: the packing, picking,
 * receiving, dispatch and till work, and the Products section those screens
 * sit in. Compared as strings, straight from the stored grants, so a key the
 * permission list does not know yet is never dropped on the way.
 */
export const OPS_SEAT_KEYS: ReadonlySet<string> = new Set([
    'section.products',
    'inventory.view',
    'inventory.pack',
    'inventory.pick',
    'inventory.receive',
    'inventory.dispatch',
    'inventory.labels',
    'pos.sell',
]);

/** Roles on the bill. Viewers, vendors and influencers are free. */
export const BILLED_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];

export type Seat = 'full' | 'ops' | 'free';

/**
 * The seat a member takes. An agent whose grants are all ops work is an ops
 * seat; one with no grants at all has every section, so takes a full seat.
 */
export function seatOf(role: UserRole, permissions: unknown): Seat {
    if (!BILLED_ROLES.includes(role)) return 'free';
    if (role !== UserRole.AGENT) return 'full';
    const grants = (permissions as { grants?: unknown } | null)?.grants;
    const keys = Array.isArray(grants) ? grants.filter((g): g is string => typeof g === 'string') : [];
    return keys.length > 0 && keys.every((k) => OPS_SEAT_KEYS.has(k)) ? 'ops' : 'full';
}
