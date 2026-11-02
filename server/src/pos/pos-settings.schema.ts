import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** A UPI id (virtual payment address): name@bank. */
const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

/** A cleared text field arrives as '' and is stored as null. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/**
 * Each setting without its default, so a patch only touches the keys it
 * sends: in Zod 4 a default inside an optional still fills a missing key,
 * which would reset every setting the patch left out.
 */
const fields = {
    upiId: z.preprocess(blankToNull, z.string().trim().regex(UPI_ID, 'Enter a UPI id like name@bank.').nullable()),
    upiPayeeName: z.preprocess(blankToNull, z.string().trim().max(100, 'Keep the UPI payee name under 100 characters.').nullable()),
    /** Round the amount to pay to the nearest rupee. */
    roundOff: z.boolean(),
    /** Every sale needs a staff member to unlock the till with their PIN. */
    requireStaffPin: z.boolean(),
    /** A bill's total discount above this percentage needs a manager's PIN; null never does. */
    discountApprovalPercent: z.number().min(0, 'The discount limit must be between 0 and 100 percent.').max(100, 'The discount limit must be between 0 and 100 percent.').nullable(),
    /** Selling at a price other than the catalogue's needs a manager's PIN. */
    priceOverrideNeedsApproval: z.boolean(),
    /** Thermal paper width in millimetres. */
    receiptWidth: z.union([z.literal(58), z.literal(80)], { error: 'The receipt width must be 58 or 80 mm.' }),
    receiptFooter: z.preprocess(blankToNull, z.string().trim().max(300, 'Keep the receipt footer under 300 characters.').nullable()),
    /** Variants shown as one-tap tiles on the billing screen. */
    tileVariantIds: z.array(z.string().min(1).max(40)).max(24, 'Pick at most 24 quick tiles.').transform((ids) => [...new Set(ids)]),
    /** Whether the till asks for the customer at checkout: never, with a skip, or always. */
    customerAtCheckout: z.enum(['off', 'ask', 'required'], { error: 'Customer at checkout is off, ask or required.' }),
    /** A bill to pay of this much or more needs the buyer's name and address (GST rule 46); null never does. */
    customerRequiredAbove: z
        .number({ error: 'Enter the bill amount as a number.' })
        .min(0, "The bill amount that needs the buyer's details can't be negative.")
        .max(10_000_000, "The bill amount that needs the buyer's details is too large.")
        .nullable(),
    /** Send the bill on WhatsApp after every sale with a mobile number. */
    autoSendBill: z.boolean(),
};

export const PosSettingsSchema = z.object({
    upiId: fields.upiId.default(null),
    upiPayeeName: fields.upiPayeeName.default(null),
    roundOff: fields.roundOff.default(true),
    requireStaffPin: fields.requireStaffPin.default(false),
    discountApprovalPercent: fields.discountApprovalPercent.default(null),
    priceOverrideNeedsApproval: fields.priceOverrideNeedsApproval.default(false),
    receiptWidth: fields.receiptWidth.default(80),
    receiptFooter: fields.receiptFooter.default(null),
    tileVariantIds: fields.tileVariantIds.default([]),
    customerAtCheckout: fields.customerAtCheckout.default('ask'),
    customerRequiredAbove: fields.customerRequiredAbove.default(50_000),
    autoSendBill: fields.autoSendBill.default(true),
});

export type PosSettings = z.infer<typeof PosSettingsSchema>;

export const UpdatePosSettingsSchema = z
    .object({
        upiId: fields.upiId.optional(),
        upiPayeeName: fields.upiPayeeName.optional(),
        roundOff: fields.roundOff.optional(),
        requireStaffPin: fields.requireStaffPin.optional(),
        discountApprovalPercent: fields.discountApprovalPercent.optional(),
        priceOverrideNeedsApproval: fields.priceOverrideNeedsApproval.optional(),
        receiptWidth: fields.receiptWidth.optional(),
        receiptFooter: fields.receiptFooter.optional(),
        tileVariantIds: fields.tileVariantIds.optional(),
        customerAtCheckout: fields.customerAtCheckout.optional(),
        customerRequiredAbove: fields.customerRequiredAbove.optional(),
        autoSendBill: fields.autoSendBill.optional(),
    })
    .strict();

export type UpdatePosSettingsInput = z.infer<typeof UpdatePosSettingsSchema>;

/** What a stored `askCustomer` from before `customerAtCheckout` meant. */
const ASKED_BEFORE: Record<string, PosSettings['customerAtCheckout']> = { true: 'ask', false: 'off', optional: 'ask', required: 'required' };

/** Stored settings with defaults filled in; a blob that no longer parses falls back to the defaults. */
export function parsePosSettings(raw: unknown): PosSettings {
    let stored = raw ?? {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const { askCustomer, ...rest } = stored as Record<string, unknown>;
        const before = ASKED_BEFORE[String(askCustomer)];
        stored = before && rest.customerAtCheckout === undefined ? { ...rest, customerAtCheckout: before } : rest;
    }
    const parsed = PosSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : PosSettingsSchema.parse({});
}

export function validatePosSettingsPatch(raw: unknown): UpdatePosSettingsInput {
    const parsed = UpdatePosSettingsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue.code === 'unrecognized_keys') {
            throw new BadRequestException(`There is no point-of-sale setting called “${issue.keys[0]}”.`);
        }
        // Our own messages are sentences; Zod's are not, so name the setting instead.
        throw new BadRequestException(issue.message.endsWith('.') ? issue.message : `Check the ${issue.path.join('.') || 'point-of-sale'} setting.`);
    }
    return parsed.data;
}
