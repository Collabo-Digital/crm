import { UserRole } from '@prisma/client';
import { PERMISSION_PRESETS } from '../auth/permissions';
import { seatOf } from './seats';

/**
 * The job templates that are priced as packing or till seats must stay
 * within the ops grants, or every member given one is billed a full seat.
 * The Cashier holds no section at all, which used to read as "every section".
 */
describe('the seat each job template takes', () => {
    const seatFor = (id: string) => {
        const preset = PERMISSION_PRESETS.find((p) => p.id === id);
        if (!preset) throw new Error(`no ${id} template`);
        return seatOf(UserRole.AGENT, { grants: [...preset.grants] });
    };

    it.each(['packer', 'warehouse', 'cashier'])('%s is a packing or till seat', (id) => {
        expect(seatFor(id)).toBe('ops');
    });

    it.each(['support', 'marketing', 'accountant'])('%s is a full seat', (id) => {
        expect(seatFor(id)).toBe('full');
    });

    it('an agent with no section key, who can open every section, is a full seat', () => {
        expect(seatOf(UserRole.AGENT, { grants: ['inventory.pack'] })).toBe('full');
    });
});
