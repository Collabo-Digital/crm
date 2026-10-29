import { BadRequestException } from '@nestjs/common';
import { OrderFinancialStatus } from '@prisma/client';
import { formatMoney } from '../commerce/order-vars';

/**
 * The arithmetic of a point-of-sale bill that is not GST: discounts as the
 * counter gives them, the manager approvals they need, rounding the amount to
 * pay, and what the payments come to. Pure, so every rule is pinned by a test.
 */

export type PosDiscount = { type: 'percent' | 'amount'; value: number };
export type PosPaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'OTHER';
export interface PosPaymentInput {
    method: PosPaymentMethod;
    amount: number;
    tendered?: number | null;
    reference?: string | null;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Down to the paisa; the epsilon keeps 0.29 × 100 = 28.999… from losing a paisa. */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
/** Amounts within half a paisa are the same amount. */
const EPS = 0.005;

export const rupees = (n: number) => formatMoney(n, 'INR');

/** A discount as an amount off `base`. */
export function discountAmount(d: PosDiscount | undefined, base: number): number {
    if (!d) return 0;
    return d.type === 'percent' ? round2((base * d.value) / 100) : round2(d.value);
}

/**
 * Each line's discount as one amount off the line, the form
 * `createOfflineOrder` takes: the line's own discount, then the cart discount
 * spread over the lines by what is left of each, the remainder on the last.
 */
export function spreadDiscounts(lines: Array<{ gross: number; discount?: PosDiscount }>, cart?: PosDiscount): number[] {
    const own = lines.map((l) => {
        const d = discountAmount(l.discount, l.gross);
        if (d > l.gross + EPS) throw new BadRequestException("A line's discount can't be more than its price.");
        return Math.min(d, l.gross);
    });
    const nets = lines.map((l, i) => round2(l.gross - own[i]));
    const base = round2(nets.reduce((sum, n) => sum + n, 0));
    const cartAmount = discountAmount(cart, base);
    if (cartAmount > base + EPS) throw new BadRequestException("The discount can't be more than the bill.");

    const shares = nets.map(() => 0);
    const last = nets.map((n) => n > 0).lastIndexOf(true);
    if (cartAmount > 0 && last >= 0) {
        let left = cartAmount;
        nets.forEach((net, i) => {
            if (i === last || net <= 0) return;
            shares[i] = Math.min(net, floor2((cartAmount * net) / base));
            left = round2(left - shares[i]);
        });
        shares[last] = left;
        // Rounding the others down can leave the last line more than it holds;
        // the excess goes back onto lines with room, a paisa or two each.
        let excess = round2(shares[last] - nets[last]);
        if (excess > 0) {
            shares[last] = nets[last];
            for (let i = 0; i < nets.length && excess > 0; i++) {
                const take = Math.min(round2(nets[i] - shares[i]), excess);
                shares[i] = round2(shares[i] + take);
                excess = round2(excess - take);
            }
        }
    }
    return own.map((d, i) => round2(d + shares[i]));
}

/** True when the bill's total discount is over the limit a manager must approve. */
export function discountNeedsApproval(limitPercent: number | null, totalDiscount: number, gross: number): boolean {
    if (limitPercent === null || totalDiscount <= 0 || gross <= 0) return false;
    return (totalDiscount / gross) * 100 > limitPercent + 1e-9;
}

/** The amount to pay: the total, or with round-off the nearest rupee, and the difference. */
export function payableFor(total: number, roundOff: boolean): { payable: number; roundOff: number } {
    const payable = roundOff ? Math.round(total) : round2(total);
    return { payable, roundOff: round2(payable - total) };
}

export function paymentStatus(paid: number, payable: number): OrderFinancialStatus {
    if (paid >= payable - EPS) return OrderFinancialStatus.PAID;
    if (paid > 0) return OrderFinancialStatus.PARTIALLY_PAID;
    return OrderFinancialStatus.PENDING;
}

/**
 * What the payments come to and the change to hand back. Refuses payments
 * over what is due: cash over the amount is `tendered`, not a bigger amount.
 */
export function settlePayments(payments: PosPaymentInput[], due: number): { paid: number; change: number } {
    let change = 0;
    for (const p of payments) {
        if (p.method !== 'CASH' || p.tendered == null) continue;
        if (p.tendered < p.amount - EPS) throw new BadRequestException('The cash handed over is less than the amount paid in cash.');
        change += p.tendered - p.amount;
    }
    const paid = round2(payments.reduce((sum, p) => sum + p.amount, 0));
    if (paid > due + EPS) {
        throw new BadRequestException(`The payments come to ${rupees(paid)}, more than the ${rupees(due)} due.`);
    }
    return { paid, change: round2(change) };
}

/** The method most of the bill was paid by (the first on a tie), or null when nothing was paid. */
export function mainPaymentMethod(payments: PosPaymentInput[]): PosPaymentMethod | null {
    let best: PosPaymentInput | null = null;
    for (const p of payments) if (!best || p.amount > best.amount) best = p;
    return best?.method ?? null;
}
