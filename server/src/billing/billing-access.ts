import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingProvider, Organization, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Paid for, or authorised and about to be. */
const LIVE_SUBSCRIPTION: SubscriptionStatus[] = [SubscriptionStatus.ACTIVE, SubscriptionStatus.AUTHENTICATED];

/**
 * BILLING_ENFORCEMENT and the dates it works from. Off (the default), every
 * workspace is active and nothing is read.
 */
export type BillingRules =
    | { enforced: false }
    | {
        enforced: true;
        /** A workspace without trialEndsAt (made before trials) gets its trial from here. */
        from: Date;
        trialDays: number;
        graceDays: number;
    };

export function billingRules(config: ConfigService): BillingRules {
    if (!config.get<boolean>('billing.enforcement')) return { enforced: false };
    return {
        enforced: true,
        // Required with BILLING_ENFORCEMENT (validation.schema.ts).
        from: new Date(config.get<string>('billing.enforceFrom')!),
        trialDays: config.get<number>('billing.trialDays') ?? 14,
        graceDays: config.get<number>('billing.graceDays') ?? 7,
    };
}

/**
 * - trialing: the free trial runs.
 * - active: a paid plan, one the Collabo team set up (MANUAL), or enforcement off.
 * - grace: the trial or the last paid period is over (a payment failed, or
 *   none was made); everything still works for BILLING_GRACE_DAYS.
 * - expired: read-only until a plan is active.
 */
export type BillingAccessState = 'trialing' | 'active' | 'grace' | 'expired';

export interface BillingAccess {
    state: BillingAccessState;
    /** BILLING_ENFORCEMENT is on. */
    enforced: boolean;
    /** When the trial ends or ended; null while active. */
    trialEndsAt: Date | null;
    /** In grace and after: when the workspace turns, or turned, read-only. */
    readOnlyFrom: Date | null;
    /** Trialing or in grace: the days left, a part day counting as a day. */
    daysLeft: number | null;
}

/** The organization fields its access depends on. */
export type BillingAccessFields = Pick<Organization, 'billingProvider' | 'subscriptionStatus' | 'trialEndsAt' | 'currentPeriodEnd'>;

export const BILLING_ACCESS_SELECT = { billingProvider: true, subscriptionStatus: true, trialEndsAt: true, currentPeriodEnd: true } as const;

const ACTIVE = (enforced: boolean): BillingAccess => ({ state: 'active', enforced, trialEndsAt: null, readOnlyFrom: null, daysLeft: null });

const addDays = (at: Date, days: number) => new Date(at.getTime() + days * DAY_MS);
const daysUntil = (at: Date, now: Date) => Math.ceil((at.getTime() - now.getTime()) / DAY_MS);

/**
 * Where a workspace stands. A subscription that stopped (cancelled, or a
 * payment that failed) keeps the workspace active to the end of the period it
 * paid for; the grace period runs from the later of that and the trial's end.
 */
export function billingAccess(org: BillingAccessFields, now: Date, rules: BillingRules): BillingAccess {
    if (!rules.enforced) return ACTIVE(false);
    if (org.billingProvider === BillingProvider.MANUAL) return ACTIVE(true);
    if (org.subscriptionStatus && LIVE_SUBSCRIPTION.includes(org.subscriptionStatus)) return ACTIVE(true);

    const trialEndsAt = org.trialEndsAt ?? addDays(rules.from, rules.trialDays);
    if (now < trialEndsAt) return { state: 'trialing', enforced: true, trialEndsAt, readOnlyFrom: null, daysLeft: daysUntil(trialEndsAt, now) };
    const paidUntil = org.currentPeriodEnd;
    if (paidUntil && now < paidUntil) return ACTIVE(true);

    const graceFrom = paidUntil && paidUntil > trialEndsAt ? paidUntil : trialEndsAt;
    const readOnlyFrom = addDays(graceFrom, rules.graceDays);
    if (now < readOnlyFrom) return { state: 'grace', enforced: true, trialEndsAt, readOnlyFrom, daysLeft: daysUntil(readOnlyFrom, now) };
    return { state: 'expired', enforced: true, trialEndsAt, readOnlyFrom, daysLeft: null };
}

/** The trial's end for a workspace made now: only while enforcement is on. */
export function newTrialEnd(rules: BillingRules, now: Date): Date | null {
    return rules.enforced ? addDays(now, rules.trialDays) : null;
}

/** What a refused write says. */
export const READ_ONLY_MESSAGE = 'This workspace is read-only until a plan is active. The owner can choose one in Settings → Billing.';

/** Why a message or broadcast was not sent from a read-only workspace. */
export const NOT_SENT_READ_ONLY = 'Not sent: the workspace is read-only until a plan is active.';

/** Loads a workspace's billing fields only while enforcement is on. */
@Injectable()
export class BillingAccessService {
    readonly rules: BillingRules;

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
    ) {
        this.rules = billingRules(config);
    }

    get enforced(): boolean {
        return this.rules.enforced;
    }

    of(org: BillingAccessFields, now = new Date()): BillingAccess {
        return billingAccess(org, now, this.rules);
    }

    async forOrg(organizationId: string, now = new Date()): Promise<BillingAccess> {
        if (!this.rules.enforced) return ACTIVE(false);
        const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: BILLING_ACCESS_SELECT });
        return org ? billingAccess(org, now, this.rules) : ACTIVE(true);
    }

    /** Expired: writes are refused, and nothing is sent for the workspace. */
    async isReadOnly(organizationId: string): Promise<boolean> {
        return (await this.forOrg(organizationId)).state === 'expired';
    }
}
