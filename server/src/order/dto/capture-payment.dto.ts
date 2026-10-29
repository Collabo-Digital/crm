import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Capture an authorized payment.
 *
 * For SHOPIFY orders, the service looks up the order's authorize transaction
 * and calls orderCapture against it.
 *
 * MANUAL orders have no authorize/capture cycle and are refused; they use
 * mark-paid. Pass `amount` (in the customer's currency) to capture part of the
 * balance; omitting it captures everything Shopify still holds.
 */
export class CapturePaymentDto {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  amount?: number;

  /** Must be the order's presentment currency when given. */
  @IsOptional() @IsString()
  currency?: string;

  /** True = close the auth (cannot capture further). Default false. */
  @IsOptional() @IsBoolean()
  finalCapture?: boolean = false;
}
