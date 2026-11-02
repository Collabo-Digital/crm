import { IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCreditNoteDto {
  /**
   * Why the credit note was raised — goods returned, deficiency in service,
   * price revised. Printed on the document and reported with it.
   */
  @IsString()
  @MaxLength(500)
  reason: string;

  /**
   * Amount to credit, inclusive of tax. Omit for a FULL reversal of whatever
   * remains uncredited.
   *
   * A partial credit is spread across the original lines by value, so every
   * line keeps its own GST rate. Which specific items came back is not
   * knowable from an amount alone, and guessing would put the reversal
   * against the wrong rate. Untaxed shipping is credited only after the goods,
   * unless `tax` says otherwise.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount?: number;

  /**
   * GST included in `amount`, when known (Shopify reports it on the refund).
   * The note then reverses exactly this much GST and the goods it was charged
   * on, and the rest of the amount is untaxed shipping. Read only with
   * `amount`.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
