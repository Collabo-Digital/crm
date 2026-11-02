import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { BUCKETS, CONFIRM_REASONS, HOLD_REASONS, PROBLEM_REASONS } from './packing-rules';

/**
 * Request bodies and queries of the packing API. Unknown keys are dropped
 * rather than refused: a stray field from the scanner screen must never
 * fail a scan at the packing table.
 */

const ClientScanId = z
    .string({ error: 'Each action needs a clientScanId.' })
    .trim()
    .min(1, 'Each action needs a clientScanId.')
    .max(100, 'The clientScanId is too long.');

const Units = (what: string) =>
    z
        .number({ error: `Enter the ${what} as a number.` })
        .int(`The ${what} is a whole number.`)
        .max(100_000, `The ${what} is too large.`);

export const QueueQuerySchema = z.object({
    bucket: z.enum(BUCKETS, { error: 'Pick a list: to_pack, packing, on_hold or packed.' }).default('to_pack'),
    warehouseId: z.string().trim().max(100).optional(),
    search: z.string().trim().max(100, 'Keep the search under 100 characters.').optional(),
    page: z.coerce.number({ error: 'The page is a number.' }).int().min(1, 'Pages start at 1.').default(1),
    limit: z.coerce.number({ error: 'The limit is a number.' }).int().min(1).max(100, 'Show at most 100 orders a page.').default(25),
});

export const AccuracyQuerySchema = z.object({
    from: z.string().trim().max(40).optional(),
    to: z.string().trim().max(40).optional(),
    warehouseId: z.string().trim().max(100).optional(),
});

export const ScanSchema = z.object({
    code: z
        .string({ error: 'Scan or type a barcode or SKU.' })
        .trim()
        .min(1, 'Scan or type a barcode or SKU.')
        .max(200, 'That code is too long to be a barcode or SKU.'),
    clientScanId: ClientScanId,
});

export const ConfirmSchema = z.object({
    qty: Units('quantity').min(1, 'Confirm at least 1.'),
    clientScanId: ClientScanId,
    reason: z.enum(CONFIRM_REASONS, { error: 'Say why: no_barcode, barcode_damaged or other.' }).optional(),
});

export const CountSchema = z.object({
    packed: Units('count').min(0, "The count can't be negative."),
    clientScanId: ClientScanId,
});

export const UndoSchema = z.object({ clientScanId: ClientScanId });

export const ProblemSchema = z.object({
    reason: z.enum(PROBLEM_REASONS, { error: 'Say what is wrong: missing, damaged or wrong_item_on_shelf.' }),
    qty: Units('quantity').min(1, 'Report at least 1.'),
});

export const HoldSchema = z.object({
    reason: z.enum(HOLD_REASONS, { error: 'Say why: items_short, damaged, customer_request or other.' }),
    note: z.string({ error: 'The note is text.' }).trim().max(500, 'Keep the note under 500 characters.').optional(),
});

export const FinishSchema = z.object({
    mode: z.enum(['all', 'partial'], { error: 'Finish with mode all or partial.' }),
});

export function parsePackingInput<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    if (issue.message.endsWith('.')) throw new BadRequestException(issue.message);
    const where = issue.path.length ? ` (${issue.path.join('.')})` : '';
    throw new BadRequestException(`Check the ${what}${where}.`);
}
