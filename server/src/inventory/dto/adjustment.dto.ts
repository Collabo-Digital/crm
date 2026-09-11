import { StockBucket } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';

/**
 * Reasons a quantity moved. The first five are the original set and still
 * appear on historic ledger rows; the rest were added to match the vocabulary
 * Shopify's own adjustment dialog uses, so a merchant reading our history
 * recognises the words. Extend here and in the client's ledger filter together.
 */
export const ADJUSTMENT_REASONS = [
  'adjustment',
  'count',
  'damage',
  'found',
  'correction',
  'received',
  'restock',
  'shrinkage',
  'quality',
  'other',
] as const;

/**
 * Manual stock adjustment for one variant × warehouse × bucket. Exactly one of
 * `delta` (signed change) or `setTo` (absolute target) must be provided —
 * validated in the service (class-validator can't express XOR cleanly).
 */
export class CreateAdjustmentDto {
  @IsString()
  variantId: string;

  // Required, deliberately. This endpoint is warehousing-only, and a merchant
  // works one location at a time — an omitted id used to fall back to the org
  // default, which silently wrote the adjustment to the wrong location.
  @IsString()
  warehouseId: string;

  @IsEnum(StockBucket)
  bucket: StockBucket;

  @IsOptional()
  @IsInt()
  @NotEquals(0)
  delta?: number;

  @IsOptional()
  @IsInt()
  setTo?: number;

  // Why the stock moved — drives ledger reporting. 'adjustment' when omitted.
  @IsOptional()
  @IsIn(ADJUSTMENT_REASONS as unknown as string[])
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** One line of a bulk save. Same shape as above, minus the shared fields. */
export class BulkAdjustmentItemDto {
  @IsString()
  variantId: string;

  @IsEnum(StockBucket)
  bucket: StockBucket;

  @IsOptional()
  @IsInt()
  @NotEquals(0)
  delta?: number;

  @IsOptional()
  @IsInt()
  setTo?: number;
}

/**
 * Saves a screenful of edited quantities at one location in a single
 * transaction. All-or-nothing on purpose: a half-applied stocktake is worse
 * than a rejected one, and the response names the line that failed so the UI
 * can flag that row rather than discarding the merchant's other edits.
 */
export class BulkAdjustmentDto {
  @IsString()
  warehouseId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkAdjustmentItemDto)
  items: BulkAdjustmentItemDto[];

  @IsOptional()
  @IsIn(ADJUSTMENT_REASONS as unknown as string[])
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
