import { ConflictException, ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { PosStaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { MAX_PIN_FAILURES, MAX_PIN_SETS, PosStaffService } from './pos-staff.service';
import { posTokenKey, readPosToken, signPosToken } from './pos-tokens';

/**
 * PINs unlock the till and approve what the store's limits don't allow. A
 * PIN is short, so the only thing standing between it and a guess is the
 * lock after five wrong tries; and approvals are spent once.
 */

const ORG = 'org_1';
const USER = 'u_device';
const SECRET = 'a'.repeat(32);

/** RedisService over ioredis-mock, which runs the real commands and Lua, one at a time like Redis. */
async function realRedis() {
    const service = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (service as unknown as { client: unknown }).client = client;
    await client.flushall();
    return service;
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
    const redis = await realRedis();
    const service = new PosStaffService(prisma, redis, { get: () => SECRET } as any);
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
        await expect(service.create(ORG, USER, { name: 'Anu', role: 'CASHIER', pin: '1234' })).rejects.toThrow(new ConflictException('Another staff member already uses this PIN.'));
        await expect(service.update(ORG, USER, 'st_mgr', { pin: '1234' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('lets a staff member keep their own PIN, and stores only its hash', async () => {
        const { service, prisma } = await build(team);
        await service.update(ORG, USER, 'st_cash', { pin: '1234', name: 'Ravi K' });
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

/**
 * Each PIN check reads the active staff once and compares the PIN with each
 * of them, so the reads count the PINs that were tried.
 */
const pinChecks = (prisma: unknown) => (prisma as { posStaff: { findMany: jest.Mock } }).posStaff.findMany.mock.calls.length;
const failuresLogged = (prisma: unknown) =>
    (prisma as { posActivity: { create: jest.Mock } }).posActivity.create.mock.calls.filter(([arg]: [{ data: { type: string } }]) => arg.data.type === 'pin_failed').length;

describe('PosStaffService PIN guessing', () => {
    it('compares no more approval PINs than the lock allows when guesses arrive all at once', async () => {
        const { service, prisma } = await build(team);
        const guesses = Array.from({ length: 20 }, (_, i) => service.approve(ORG, USER, { pin: String(100000 + i), reason: 'discount' }));
        const right = service.approve(ORG, USER, { pin: '987654', reason: 'discount' });

        const results = await Promise.allSettled([...guesses, right]);

        expect(pinChecks(prisma)).toBe(MAX_PIN_FAILURES);
        expect(failuresLogged(prisma)).toBe(MAX_PIN_FAILURES);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);
        expect(results.at(-1)).toMatchObject({ status: 'rejected', reason: { status: HttpStatus.TOO_MANY_REQUESTS } });
    });

    it('compares no more unlock PINs than the lock allows when guesses arrive all at once', async () => {
        const { service, prisma } = await build(team);
        const guesses = Array.from({ length: 20 }, (_, i) => service.unlock(ORG, USER, String(5000 + i)));
        const right = service.unlock(ORG, USER, '1234');

        const results = await Promise.allSettled([...guesses, right]);

        expect(pinChecks(prisma)).toBe(MAX_PIN_FAILURES);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);
        expect(results.at(-1)).toMatchObject({ status: 'rejected', reason: { status: HttpStatus.TOO_MANY_REQUESTS } });
    });

    it('does not count a right PIN as a wrong try', async () => {
        const { service } = await build(team);
        for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) await expect(service.unlock(ORG, USER, '0000')).rejects.toBeInstanceOf(UnauthorizedException);
        for (let i = 0; i < 10; i++) await expect(service.unlock(ORG, USER, '1234')).resolves.toMatchObject({ staff: { id: 'st_cash' } });

        await expect(service.unlock(ORG, USER, '0000')).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(service.unlock(ORG, USER, '1234')).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });
});

describe('PosStaffService PIN setting', () => {
    it('stops a member trying PIN after PIN through staff changes, before comparing it with anyone', async () => {
        const { service, prisma } = await build(team);
        for (let i = 0; i < MAX_PIN_SETS; i++) {
            await expect(service.update(ORG, USER, 'st_cash', { pin: String(2000 + i) })).resolves.toMatchObject({ id: 'st_cash' });
        }
        const checks = pinChecks(prisma);

        await expect(service.update(ORG, USER, 'st_cash', { pin: '987654' })).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        await expect(service.create(ORG, USER, { name: 'Anu', role: 'CASHIER', pin: '987654' })).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        expect(pinChecks(prisma)).toBe(checks);

        // Changes without a PIN, and another member, are not held up.
        await expect(service.update(ORG, USER, 'st_cash', { name: 'Ravi K' })).resolves.toMatchObject({ name: 'Ravi K' });
        await expect(service.create(ORG, 'u_owner', { name: 'Anu', role: 'CASHIER', pin: '5555' })).resolves.toMatchObject({ name: 'Anu' });
    });

    it('compares no more new PINs than allowed when they arrive all at once', async () => {
        const { service, prisma } = await build(team);

        const results = await Promise.allSettled(
            Array.from({ length: MAX_PIN_SETS + 10 }, (_, i) => service.create(ORG, USER, { name: `Staff ${i}`, role: 'CASHIER', pin: String(300000 + i) })),
        );

        expect(pinChecks(prisma)).toBe(MAX_PIN_SETS);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(10);
    });
});
