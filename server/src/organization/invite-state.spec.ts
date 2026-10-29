import { InviteStatus } from '@prisma/client';
import { deriveInviteState } from './invites.service';

/**
 * Expiry is a moment passing, not an event anything fires. Nothing writes
 * EXPIRED to a row, so a PENDING invitation whose date has gone by is expired
 * in fact while still PENDING in the table — and the merchant must be told the
 * fact. This pins that derivation.
 */
describe('deriveInviteState', () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const past = new Date('2026-09-01T12:00:00.000Z');
    const future = new Date('2026-09-30T12:00:00.000Z');

    it('reports a live pending invitation as pending', () => {
        expect(deriveInviteState({ status: InviteStatus.PENDING, expiresAt: future }, now)).toBe(
            'PENDING',
        );
    });

    it('reports a lapsed pending invitation as expired, though the row still says PENDING', () => {
        expect(deriveInviteState({ status: InviteStatus.PENDING, expiresAt: past }, now)).toBe(
            'EXPIRED',
        );
    });

    it('treats the expiry instant itself as expired', () => {
        expect(deriveInviteState({ status: InviteStatus.PENDING, expiresAt: now }, now)).toBe(
            'EXPIRED',
        );
    });

    it('leaves a terminal status alone even when the date has passed', () => {
        // An accepted invitation does not become "expired" a week later, and a
        // cancelled one must keep reading as cancelled so the UI offers
        // "Invite again" rather than "Send new invitation".
        expect(deriveInviteState({ status: InviteStatus.ACCEPTED, expiresAt: past }, now)).toBe(
            'ACCEPTED',
        );
        expect(deriveInviteState({ status: InviteStatus.REVOKED, expiresAt: past }, now)).toBe(
            'REVOKED',
        );
        expect(deriveInviteState({ status: InviteStatus.EXPIRED, expiresAt: future }, now)).toBe(
            'EXPIRED',
        );
    });
});
