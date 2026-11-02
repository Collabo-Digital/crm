import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { WarehouseService } from './warehouse.service';

/**
 * Switching a location off takes it out of the stores every member works at,
 * and is refused while a Manager or Agent works only there: an emptied list
 * would mean every location.
 */
describe('switching a location off', () => {
  type Member = { locationScope: string[]; role?: UserRole; user: { firstName: string; lastName: string; email: string } };

  function build(members: Member[] = [], invites: Array<{ locationScope: string[]; email: string; name: string | null }> = []) {
    const store = {
      id: 'st_bandra', organizationId: 'org', name: 'Bandra store', code: 'BAN', kind: 'STORE', isDefault: false,
      isActive: true, address: null, gstinId: null, shopifyLocationId: null, apobDeclared: false, createdAt: new Date(1),
    };
    const db = {
      warehouse: {
        findFirst: jest.fn(() => Promise.resolve(store)),
        findMany: jest.fn(() => Promise.resolve([{ ...store, _count: { locations: 0, stockLevels: 0 } }])),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(Object.assign(store, data))),
        updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
      organizationMember: { findMany: jest.fn(() => Promise.resolve(members)) },
      teamInvite: { findMany: jest.fn(() => Promise.resolve(invites)) },
      stockLevel: { groupBy: jest.fn(() => Promise.resolve([])) },
      organization: { findUnique: jest.fn(() => Promise.resolve({ gstEnabled: false })) },
      organizationGstin: { findMany: jest.fn(() => Promise.resolve([])), count: jest.fn(() => Promise.resolve(0)) },
      shopifyLocationLink: { findMany: jest.fn(() => Promise.resolve([])) },
      $executeRaw: jest.fn(() => Promise.resolve(1)),
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
    const service = new WarehouseService(db as never, {} as never);
    return { service, db, store };
  }

  const person = (firstName: string, scope: string[]): Member => ({
    locationScope: scope,
    user: { firstName, lastName: 'Shah', email: `${firstName.toLowerCase()}@shop.in` },
  });

  it('is refused while someone works only there, naming them', async () => {
    const { service, db } = build([person('Priya', ['st_bandra']), person('Ravi', ['st_bandra', 'st_andheri'])], [
      { locationScope: ['st_bandra'], email: 'new@shop.in', name: null },
    ]);
    const attempt = service.update('org', 'st_bandra', { isActive: false });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('org', 'st_bandra', { isActive: false })).rejects.toThrow(
      'Priya Shah and new@shop.in work only at Bandra store. Choose another store for each of them in Settings → Team members, then switch this location off.',
    );
    expect(db.warehouse.update).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("takes it out of everyone's stores in the same transaction as switching it off", async () => {
    const { service, db, store } = build([person('Ravi', ['st_bandra', 'st_andheri'])]);
    await service.update('org', 'st_bandra', { isActive: false });
    expect(store.isActive).toBe(false);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    for (const call of db.$executeRaw.mock.calls as unknown[][]) {
      expect(call.slice(1)).toContainEqual(['st_bandra']);
    }
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves the stores alone for any other edit', async () => {
    const { service, db } = build([person('Priya', ['st_bandra'])]);
    await service.update('org', 'st_bandra', { name: 'Bandra West' });
    expect(db.organizationMember.findMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
