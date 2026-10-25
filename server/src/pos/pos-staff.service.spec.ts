import { ConflictException, ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { PosStaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PosStaffService } from './pos-staff.service';
import { posTokenKey, readPosToken, signPosToken } from './pos-tokens';

/**
 * PINs unlock the till and approve what the store's limits don't allow. A
 * PIN is short, so the only thing standing between it and a guess is the
 * lock after five wrong tries; and approvals are spent once.
 */

const ORG = 'org_1';
const USER = 'u_device';
const SECRET = 'a'.repeat(32);

function fakeRedis() {
    const store = new Map<string, unknown>();
    return {
        store,
        get: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
        del: jest.fn(async (k: string) => void store.delete(k)),
        acquireLock: jest.fn(async (k: string) => {
            if (store.has(k)) return false;
            store.set(k, 1);
            return true;
        }),
        runScript: jest.fn(async (_name: string, _lua: string, _n: number, keys: string[]) => {
            const next = Number(store.get(keys[0]) ?? 0) + 1;
            store.set(keys[0], next);
            return next;
        }),
    };
}

async function build(staff: Array<{ id: string; name: string; role: PosStaffRole; pin: string; isActive?: boolean }>) {
    const rows = await Promise.all(
        staff.map(async (s) => ({ id: s.id, organizationId: ORG, name: s.name, role: s.role, isActive: s.isActive ?? true, pinHash: await bcrypt.hash(s.pin, 4) })),
    );
    const prisma: any = {
        posStaff: {
            findMany: jest.fn(async ({ where }: any) =>
                rows.filter((r) => (where.isActive === undefined || r.isActive === where.isActive) && (!where.id?.not || r.id !== where.id.not)),
            ),
            findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id && (where.isActive === undefined || r.isActive === where.isActive)) ?? null),
            create: jest.fn(async ({ data }: any) => ({ id: 'new', isActive: true, ...data })),
            update: jest.fn(async ({ where, data }: any) => ({ ...rows.find((r) => r.id === where.id), ...data })),
        },
        posActivity: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const redis = fakeRedis();
    const service = new PosStaffService(prisma, redis as any, { get: () => SECRET } as any);
    return { service, prisma, redis };
}

const team = [
    { id: 'st_cash', name: 'Ravi', role: PosStaffRole.CASHIER, pin: '1234' },
    { id: 'st_mgr', name: 'Meera', role: PosStaffRole.MANAGER, pin: '987654' },
];

describe('PosStaffService.unlock', () => {
    it('unlocks for the staff member whose PIN it is, for 12 hours, and logs it', async () => {
        const { service, prisma } = await build(team);
        const before = Date.now();
        const out = await service.unlock(ORG, USER, '1234');
        expect(out.staff).toEqual({ id: 'st_cash', name: 'Ravi', role: 'CASHIER', isActive: true });
        expect(Date.parse(out.expiresAt) - before).toBeGreaterThanOrEqual(12 * 3600_000 - 1000);
        expect(prisma.posActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'unlock', posStaffId: 'st_cash', deviceUserId: USER }) });
        expect((await service.staffFromToken(ORG, USER, out.staffToken))?.id).toBe('st_cash');
    });

    it('refuses a wrong PIN with 401 and logs the failed try', async () => {
        const { service, prisma } = await build(team);
        await expect(service.unlock(ORG, USER, '0000')).rejects.toThrow(new UnauthorizedException("That PIN doesn't match anyone here."));
        expect(prisma.posActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'pin_failed', deviceUserId: USER }) });
    });

    it('locks after more than five wrong tries, even for a right PIN', async () => {
        const { service } = await build(team);
        for (let i = 0; i < 5; i++) await expect(service.unlock(ORG, USER, '0000')).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(service.unlock(ORG, USER, '0000')).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        await expect(service.unlock(ORG, USER, '1234')).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });

    it('counts wrong tries per signed-in member', async () => {
        const { service } = await build(team);
        for (let i = 0; i < 6; i++) await service.unlock(ORG, USER, '0000').catch(() => undefined);
        await expect(service.unlock(ORG, 'u_other_device', '1234')).resolves.toMatchObject({ staff: { id: 'st_cash' } });
    });

    it('does not unlock for a switched-off staff member', async () => {
        const { service } = await build([{ ...team[0], isActive: false }]);
        await expect(service.unlock(ORG, USER, '1234')).rejects.toBeInstanceOf(UnauthorizedException);
    });
});

describe('PosStaffService.approve', () => {
    it("only takes a manager's PIN", async () => {
        const { service } = await build(team);
        await expect(service.approve(ORG, USER, { pin: '1234', reason: 'discount' })).rejects.toThrow(new ForbiddenException("Only a manager's PIN can approve this."));
    });

    it('gives a 5-minute approval naming the manager and the reason, and logs it', async () => {
        const { service, prisma } = await build(team);
        const out = await service.approve(ORG, USER, { pin: '987654', reason: 'discount', amount: 250 });
        expect(out.approver.id).toBe('st_mgr');
        const claims = service.readApproval(ORG, USER, out.approvalToken)!;
        expect(claims).toMatchObject({ staff: 'st_mgr', reason: 'discount', amount: 250 });
        expect(claims.exp - Date.now()).toBeLessThanOrEqual(5 * 60_000);
        expect(prisma.posActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'approval', approvedById: 'st_mgr' }) });
    });

    it('an approval can be spent once, and given back when its sale fails', async () => {
        const { service } = await build(team);
        const { approvalToken } = await service.approve(ORG, USER, { pin: '987654', reason: 'price_override' });
        const claims = service.readApproval(ORG, USER, approvalToken)!;
        expect(await service.consumeApproval(claims)).toBe(true);
        expect(await service.consumeApproval(claims)).toBe(false);
        await service.releaseApproval(claims);
        expect(await service.consumeApproval(claims)).toBe(true);
    });

    it('wrong PINs here count towards the same lock', async () => {
        const { service } = await build(team);
        for (let i = 0; i < 6; i++) await service.approve(ORG, USER, { pin: '1111', reason: 'discount' }).catch(() => undefined);
        await expect(service.approve(ORG, USER, { pin: '987654', reason: 'discount' })).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });
});

describe('PosStaffService tokens', () => {
    it('a token is bound to its org, member and kind', async () => {
        const { service } = await build(team);
        const { staffToken } = await service.unlock(ORG, USER, '1234');
        expect(await service.staffFromToken('org_2', USER, staffToken)).toBeNull();
        expect(await service.staffFromToken(ORG, 'u_someone_else', staffToken)).toBeNull();
        expect(service.readApproval(ORG, USER, staffToken)).toBeNull();
    });

    it('refuses a tampered or expired token', () => {
        const key = posTokenKey(SECRET);
        const { token } = signPosToken(key, { kind: 'staff', org: ORG, user: USER, staff: 'st_mgr', exp: Date.now() + 60_000 });
        const [prefix, body, sig] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), staff: 'st_cash' })).toString('base64url');
        expect(readPosToken(key, `${prefix}.${forged}.${sig}`, { kind: 'staff', org: ORG, user: USER })).toBeNull();
        expect(readPosToken(posTokenKey('b'.repeat(32)), token, { kind: 'staff', org: ORG, user: USER })).toBeNull();
        const { token: old } = signPosToken(key, { kind: 'staff', org: ORG, user: USER, staff: 'st_mgr', exp: Date.now() - 1 });
        expect(readPosToken(key, old, { kind: 'staff', org: ORG, user: USER })).toBeNull();
    });

    it('a staff member switched off after unlocking no longer bills', async () => {
        const { service, prisma } = await build(team);
        const { staffToken } = await service.unlock(ORG, USER, '1234');
        prisma.posStaff.findFirst.mockResolvedValueOnce(null);
        expect(await service.staffFromToken(ORG, USER, staffToken)).toBeNull();
    });
});

describe('PosStaffService staff', () => {
    it('refuses a PIN another active staff member uses', async () => {
        const { service } = await build(team);
        await expect(service.create(ORG, { name: 'Anu', role: 'CASHIER', pin: '1234' })).rejects.toThrow(new ConflictException('Another staff member already uses this PIN.'));
        await expect(service.update(ORG, 'st_mgr', { pin: '1234' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('lets a staff member keep their own PIN, and stores only its hash', async () => {
        const { service, prisma } = await build(team);
        await service.update(ORG, 'st_cash', { pin: '1234', name: 'Ravi K' });
        const data = prisma.posStaff.update.mock.calls[0][0].data;
        expect(data.name).toBe('Ravi K');
        expect(data.pinHash).not.toBe('1234');
        expect(await bcrypt.compare('1234', data.pinHash)).toBe(true);
    });

    it('a PIN two active people ended up sharing unlocks for neither', async () => {
        const { service } = await build([team[0], { id: 'st_back', name: 'Back', role: PosStaffRole.CASHIER, pin: '1234' }]);
        await expect(service.unlock(ORG, USER, '1234')).rejects.toBeInstanceOf(ConflictException);
    });
});
