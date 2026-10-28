import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PosStaff, PosStaffRole, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ApproveInput, CreateStaffInput, UpdateStaffInput } from './pos-requests.schema';
import {
    APPROVAL_TOKEN_TTL_MS,
    PosTokenClaims,
    STAFF_TOKEN_TTL_MS,
    posTokenKey,
    readPosToken,
    signPosToken,
} from './pos-tokens';

export type PosStaffView = { id: string; name: string; role: PosStaffRole; isActive: boolean };

export const toStaffView = (s: Pick<PosStaff, 'id' | 'name' | 'role' | 'isActive'>): PosStaffView => ({
    id: s.id,
    name: s.name,
    role: s.role,
    isActive: s.isActive,
});

/** Wrong PINs a signed-in member may enter in the window before the till locks. */
export const MAX_PIN_FAILURES = 5;
export const PIN_FAILURE_WINDOW_S = 5 * 60;
/**
 * PINs a signed-in member may give staff in an hour. Each one is checked
 * against every staff member's, and "already in use" tells whose PIN it is
 * not, so setting PINs must not be a faster way to guess one than the till.
 */
export const MAX_PIN_SETS = 20;
export const PIN_SET_WINDOW_S = 3600;

const COUNT_LUA = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
const GIVE_BACK_LUA = `if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * The people who bill at the counter, the PINs that unlock the till for them,
 * and a manager's PIN approving what the store's limits do not allow.
 */
@Injectable()
export class PosStaffService {
    private readonly tokenKey: Buffer;

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        config: ConfigService,
    ) {
        this.tokenKey = posTokenKey(config.get<string>('jwt.accessSecret')!);
    }

    async list(orgId: string, includeInactive: boolean): Promise<PosStaffView[]> {
        const rows = await this.prisma.posStaff.findMany({
            where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
            orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        });
        return rows.map(toStaffView);
    }

    async create(orgId: string, userId: string, input: CreateStaffInput): Promise<PosStaffView> {
        await this.countPinSet(orgId, userId);
        await this.assertPinFree(orgId, input.pin);
        const row = await this.prisma.posStaff.create({
            data: { organizationId: orgId, name: input.name, role: input.role, pinHash: await bcrypt.hash(input.pin, 10) },
        });
        return toStaffView(row);
    }

    async update(orgId: string, userId: string, id: string, input: UpdateStaffInput): Promise<PosStaffView> {
        const existing = await this.prisma.posStaff.findFirst({ where: { id, organizationId: orgId } });
        if (!existing) throw new NotFoundException('That staff member was not found.');
        // Someone switched back on keeps a PIN that can no longer be compared (only
        // its hash is stored); a clash with it is refused at unlock instead.
        if (input.pin) {
            await this.countPinSet(orgId, userId);
            await this.assertPinFree(orgId, input.pin, id);
        }
        const row = await this.prisma.posStaff.update({
            where: { id },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.role !== undefined ? { role: input.role } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
                ...(input.pin ? { pinHash: await bcrypt.hash(input.pin, 10) } : {}),
            },
        });
        return toStaffView(row);
    }

    /** Unlocks the till for whoever this PIN belongs to, for 12 hours. */
    async unlock(orgId: string, userId: string, pin: string) {
        const staff = await this.staffForPin(orgId, userId, pin, 'unlock');
        const { token, claims } = signPosToken(this.tokenKey, {
            kind: 'staff',
            org: orgId,
            user: userId,
            staff: staff.id,
            exp: Date.now() + STAFF_TOKEN_TTL_MS,
        });
        await this.log(orgId, 'unlock', { posStaffId: staff.id, deviceUserId: userId });
        return { staff: toStaffView(staff), staffToken: token, expiresAt: new Date(claims.exp).toISOString() };
    }

    /** A manager's PIN approving a discount or price change, good for one sale in the next 5 minutes. */
    async approve(orgId: string, userId: string, input: ApproveInput) {
        const approver = await this.staffForPin(orgId, userId, input.pin, 'approval');
        if (approver.role !== PosStaffRole.MANAGER) {
            throw new ForbiddenException("Only a manager's PIN can approve this.");
        }
        const { token, claims } = signPosToken(this.tokenKey, {
            kind: 'approval',
            org: orgId,
            user: userId,
            staff: approver.id,
            reason: input.reason,
            ...(input.amount !== undefined ? { amount: input.amount } : {}),
            exp: Date.now() + APPROVAL_TOKEN_TTL_MS,
        });
        await this.log(orgId, 'approval', {
            approvedById: approver.id,
            deviceUserId: userId,
            details: { reason: input.reason, ...(input.amount !== undefined ? { amount: input.amount } : {}) },
        });
        return { approver: toStaffView(approver), approvalToken: token, expiresAt: new Date(claims.exp).toISOString() };
    }

    /** The active staff member a staff token was issued to, or null when it is not a valid token for this member. */
    async staffFromToken(orgId: string, userId: string, token: string | undefined): Promise<PosStaff | null> {
        const claims = readPosToken(this.tokenKey, token, { kind: 'staff', org: orgId, user: userId });
        if (!claims) return null;
        return this.prisma.posStaff.findFirst({ where: { id: claims.staff, organizationId: orgId, isActive: true } });
    }

    /** An approval's claims, or null when it is not a valid, unexpired approval for this member. */
    readApproval(orgId: string, userId: string, token: string | undefined): PosTokenClaims | null {
        return readPosToken(this.tokenKey, token, { kind: 'approval', org: orgId, user: userId });
    }

    /** Uses up an approval. False when it was used already. */
    async consumeApproval(claims: PosTokenClaims): Promise<boolean> {
        const ttl = Math.max(1, Math.ceil((claims.exp - Date.now()) / 1000) + 60);
        return this.redis.acquireLock(`pos:approval_used:${claims.jti}`, ttl);
    }

    /** Gives an approval back when the sale it was spent on did not go through. */
    async releaseApproval(claims: PosTokenClaims): Promise<void> {
        await this.redis.del(`pos:approval_used:${claims.jti}`).catch(() => undefined);
    }

    async log(
        orgId: string,
        type: string,
        fields: { posStaffId?: string | null; approvedById?: string | null; orderId?: string | null; deviceUserId?: string | null; details?: Record<string, unknown> },
        client: Prisma.TransactionClient | PrismaService = this.prisma,
    ): Promise<void> {
        await client.posActivity.create({
            data: {
                organizationId: orgId,
                type,
                posStaffId: fields.posStaffId ?? null,
                approvedById: fields.approvedById ?? null,
                orderId: fields.orderId ?? null,
                deviceUserId: fields.deviceUserId ?? null,
                ...(fields.details ? { details: fields.details as Prisma.InputJsonObject } : {}),
            },
        });
    }

    /**
     * The active staff member whose PIN this is. Wrong PINs are counted per
     * signed-in member, and past the limit the till stays locked for the rest
     * of the window even for a right one, so a PIN cannot be guessed.
     *
     * Every try is counted before its PIN is compared: tries sent at once
     * would otherwise all pass a count none of them had added to yet. A right
     * PIN then gives its count back.
     */
    private async staffForPin(orgId: string, userId: string, pin: string, purpose: 'unlock' | 'approval'): Promise<PosStaff> {
        const key = `pos:pin_failures:${orgId}:${userId}`;
        const tries = Number(await this.redis.runScript('posPinFailure', COUNT_LUA, 1, [key], [PIN_FAILURE_WINDOW_S]));
        if (tries > MAX_PIN_FAILURES) throw this.locked();

        const matches = await this.matchPin(orgId, pin);
        if (matches.length === 0) {
            await this.log(orgId, 'pin_failed', { deviceUserId: userId, details: { purpose } });
            throw new UnauthorizedException("That PIN doesn't match anyone here.");
        }
        await this.redis.runScript('posPinGiveBack', GIVE_BACK_LUA, 1, [key], []);
        if (matches.length > 1) {
            throw new ConflictException('Two staff members share this PIN. Ask a manager to give one of them a new PIN.');
        }
        return matches[0];
    }

    private locked(): HttpException {
        return new HttpException('Too many wrong PINs. Wait five minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }

    /** Counts one PIN given to a staff member, before it is compared with anyone's. */
    private async countPinSet(orgId: string, userId: string): Promise<void> {
        const sets = Number(await this.redis.runScript('posPinSet', COUNT_LUA, 1, [`pos:pin_sets:${orgId}:${userId}`], [PIN_SET_WINDOW_S]));
        if (sets > MAX_PIN_SETS) {
            throw new HttpException('Too many PINs set in the last hour. Wait a while and try again.', HttpStatus.TOO_MANY_REQUESTS);
        }
    }

    /** Every active staff member with this PIN: one, or none, unless a clash slipped in. */
    private async matchPin(orgId: string, pin: string, exceptId?: string): Promise<PosStaff[]> {
        const staff = await this.prisma.posStaff.findMany({
            where: { organizationId: orgId, isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
        });
        const matches = await Promise.all(staff.map((s) => bcrypt.compare(pin, s.pinHash)));
        return staff.filter((_, i) => matches[i]);
    }

    private async assertPinFree(orgId: string, pin: string, exceptId?: string): Promise<void> {
        if ((await this.matchPin(orgId, pin, exceptId)).length > 0) {
            throw new ConflictException('Another staff member already uses this PIN.');
        }
    }
}
