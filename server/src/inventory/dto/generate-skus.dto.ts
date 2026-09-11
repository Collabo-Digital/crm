import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Bulk SKU/barcode generation. Either an explicit variant list or a filter —
 * when both are present the filter narrows the list; when neither is present
 * the filter defaults to every variant missing the target field.
 */
export class GenerateCodesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(2000)
  variantIds?: string[];

  /**
   * `missing-or-generated` (barcodes only) targets variants with no barcode
   * PLUS those whose barcode we minted (`barcodeSource = GENERATED`). It is how
   * "switch my catalogue to short codes" is expressed without `overwrite: true`,
   * which would also clobber real GTINs synced from Shopify.
   */
  @IsOptional()
  @IsIn(['missing-sku', 'missing-barcode', 'missing-or-generated', 'all'])
  filter?: string;

  // Never true by default: overwriting a real EAN/UPC that came from Shopify
  // would break retail scanning. Explicit opt-in only.
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;

  /**
   * Barcode value shape (generateBarcodes only).
   *
   *   'short' — a 6-digit sequence number. THE DEFAULT since 2026-08-28.
   *   'sku'   — copy the SKU verbatim. The original behaviour, kept for
   *             merchants who want the SKU itself to be scannable.
   *
   * 'short' exists because the generated SKU shape
   * ({PREFIX}-{PRODUCTCODE}-{SEQ}-{OPTIONS}, e.g. 9TH-SAR-001-BLK-FS) is 18
   * characters, which needs ~48 mm of label at a scannable module width — it
   * cannot fit 30×20, 25×15 or any jewellery tag. Alphanumerics cost ~11
   * modules each in Code 128 while digits pack two per symbol, so a 6-digit
   * code needs only ~17 mm. The long SKU still prints as human-readable text;
   * only the scannable value shortens.
   */
  @IsOptional()
  @IsIn(['sku', 'short'])
  format?: 'sku' | 'short';
}
