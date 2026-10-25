import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { GSTIN_REGEX, isGstRateSlab } from '../gst/constants/gst-rates';

/**
 * Request bodies of the point-of-sale API. Zod rather than DTO classes
 * because a bill line is one of two shapes, and every refusal must read as a
 * sentence the cashier can act on.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 10_000_000;

export const PinSchema = z.string({ error: 'Enter a PIN of 4 to 6 digits.' }).regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits.');

const amount = (what: string) =>
    z
        .number({ error: `Enter the ${what} as a number.` })
        .min(0, `The ${what} can't be negative.`)
        .max(MAX_AMOUNT, `The ${what} is too large.`);

const StaffName = z.string({ error: "Enter the staff member's name." }).trim().min(1, "Enter the staff member's name.").max(80, 'Keep the name under 80 characters.');
const StaffRole = z.enum(['CASHIER', 'MANAGER'], { error: 'The role must be CASHIER or MANAGER.' });

export const CreateStaffSchema = z.object({ name: StaffName, role: StaffRole, pin: PinSchema }).strict();
export const UpdateStaffSchema = z
    .object({ name: StaffName.optional(), role: StaffRole.optional(), pin: PinSchema.optional(), isActive: z.boolean({ error: 'isActive must be true or false.' }).optional() })
    .strict();

export const UnlockSchema = z.object({ pin: PinSchema }).strict();
export const ApproveSchema = z
    .object({
        pin: PinSchema,
        reason: z.enum(['discount', 'price_override'], { error: 'Say what is being approved: discount or price_override.' }),
        amount: amount('approved amount').optional(),
    })
    .strict();

const DiscountSchema = z
    .object({
        type: z.enum(['percent', 'amount'], { error: 'A discount is a percent or an amount.' }),
        value: amount('discount'),
    })
    .strict()
    .refine((d) => d.type !== 'percent' || d.value <= 100, "A percentage discount can't be over 100.");

const Quantity = z
    .number({ error: "Enter each line's quantity as a number." })
    .int('Quantities are whole numbers.')
    .min(1, 'Each line needs a quantity of at least 1.')
    .max(100_000, 'That quantity is too large.');

const CustomItemSchema = z
    .object({
        title: z.string({ error: 'Give the custom item a name.' }).trim().min(1, 'Give the custom item a name.').max(120, 'Keep the item name under 120 characters.'),
        unitPrice: amount('price'),
        gstRate: z
            .number({ error: 'Enter the GST rate as a number.' })
            .refine(isGstRateSlab, 'Use a GST rate of 0, 0.25, 3, 5, 12, 18 or 28 percent.')
            .optional(),
        hsn: z.string().trim().regex(/^\d{4,8}$/, 'An HSN or SAC code is 4 to 8 digits.').optional(),
    })
    .strict();

/** A product line names a variant; a custom line describes the item instead. */
const LineSchema = z
    .object({
        variantId: z.string().min(1).max(40).optional(),
        custom: CustomItemSchema.optional(),
        quantity: Quantity,
        unitPrice: amount('price').optional(),
        discount: DiscountSchema.optional(),
    })
    .strict()
    .superRefine((line, ctx) => {
        if (!line.variantId === !line.custom) {
            ctx.addIssue({ code: 'custom', message: 'Each line is either a product (variantId) or a custom item, not both.' });
        }
        if (line.custom && line.unitPrice !== undefined) {
            ctx.addIssue({ code: 'custom', message: "A custom item's price goes inside custom." });
        }
    });

const PaymentSchema = z
    .object({
        method: z.enum(['CASH', 'UPI', 'CARD', 'OTHER'], { error: 'A payment is CASH, UPI, CARD or OTHER.' }),
        amount: amount('payment').refine((v) => v > 0, 'Each payment needs an amount above zero.'),
        tendered: amount('cash handed over').optional(),
        reference: z.string().trim().max(100, 'Keep the payment reference under 100 characters.').optional(),
    })
    .strict();

const CustomerSchema = z
    .object({
        customerId: z.string().min(1).max(40).optional(),
        phone: z.string().trim().max(24, 'That phone number is too long.').optional(),
        name: z.string().trim().max(120, "Keep the customer's name under 120 characters.").optional(),
        email: z.email('Enter a valid email address.').optional(),
        gstin: z
            .string()
            .trim()
            .transform((v) => v.toUpperCase())
            .refine((v) => GSTIN_REGEX.test(v), 'Enter a valid 15-character GSTIN.')
            .optional(),
        billingStateCode: z.string().regex(/^\d{2}$/, 'The billing state code is 2 digits.').optional(),
        whatsappOptIn: z.boolean().optional(),
    })
    .strict();

export const SaleSchema = z
    .object({
        clientSaleId: z.string({ error: 'Every sale needs a clientSaleId.' }).regex(UUID, 'clientSaleId must be a UUID.'),
        storeId: z.string().min(1).max(40).optional(),
        customer: CustomerSchema.optional(),
        lines: z.array(LineSchema, { error: 'Add at least one item to the bill.' }).min(1, 'Add at least one item to the bill.').max(200, 'A bill can have at most 200 lines.'),
        cartDiscount: DiscountSchema.optional(),
        payments: z.array(PaymentSchema).max(10, 'Split a bill over at most 10 payments.').default([]),
        note: z.string().trim().max(500, 'Keep the note under 500 characters.').optional(),
        staffToken: z.string().max(2000).optional(),
        approvalToken: z.string().max(2000).optional(),
    })
    .strict();

export const CollectPaymentSchema = PaymentSchema.extend({ staffToken: z.string().max(2000).optional() }).strict();

export type CreateStaffInput = z.infer<typeof CreateStaffSchema>;
export type UpdateStaffInput = z.infer<typeof UpdateStaffSchema>;
export type ApproveInput = z.infer<typeof ApproveSchema>;
export type SaleInput = z.infer<typeof SaleSchema>;
export type SaleLineInput = SaleInput['lines'][number];
export type SaleCustomerInput = NonNullable<SaleInput['customer']>;
export type CollectPaymentInput = z.infer<typeof CollectPaymentSchema>;

/** The body, or a 400 whose message is the first problem as a sentence. */
export function parsePosBody<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    if (issue.code === 'unrecognized_keys') {
        throw new BadRequestException(`“${issue.keys[0]}” is not part of a ${what}.`);
    }
    if (issue.message.endsWith('.')) throw new BadRequestException(issue.message);
    const where = issue.path.length ? ` (${issue.path.join('.')})` : '';
    throw new BadRequestException(`Check the ${what}${where}.`);
}
