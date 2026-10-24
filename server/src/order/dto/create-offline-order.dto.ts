import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderFinancialStatus, OrderFulfillmentStatus } from '@prisma/client';
import { GSTIN_REGEX } from '../../gst/constants/gst-rates';

export class OfflineCustomerInputDto {
  @IsOptional() @IsString() customerId?: string;

  @IsOptional() @IsEmail() email?: string;

  @IsOptional() @IsString() phone?: string;

  @IsOptional() @IsString() firstName?: string;

  @IsOptional() @IsString() lastName?: string;

  @IsOptional()
  @IsString()
  @Matches(GSTIN_REGEX, {
    message:
      'Customer GSTIN must be a valid 15-character GST Identification Number',
  })
  gstin?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2, { message: 'Billing state code must be exactly 2 digits' })
  billingStateCode?: string;

  @IsOptional() @IsObject() address?: Record<string, unknown>;
}

export class OfflineLineItemDto {
  @IsString() productVariantId: string;

  @IsInt() @Min(1) quantity: number;

  @IsOptional() @IsNumber() @Min(0) unitPriceOverride?: number;

  @IsOptional() @IsNumber() @Min(0) discount?: number;
}

export class CreateOfflineOrderDto {
  @ValidateNested()
  @Type(() => OfflineCustomerInputDto)
  customer: OfflineCustomerInputDto;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one line item is required' })
  @ValidateNested({ each: true })
  @Type(() => OfflineLineItemDto)
  lineItems: OfflineLineItemDto[];

  @IsOptional() @IsString() sellerGstinId?: string;

  /**
   * Warehouse the goods leave from — an additional place of business of the
   * seller's GST registration. Omitted falls back to the org's default
   * warehouse (and to nothing at all when the org does not use warehousing).
   * Snapshotted onto the invoice as "Dispatch From".
   */
  @IsOptional() @IsString() warehouseId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2, { message: 'Place of supply code must be exactly 2 digits' })
  placeOfSupplyCode?: string;

  @IsIn(['CASH', 'CARD', 'UPI', 'OTHER'])
  paymentMethod: 'CASH' | 'CARD' | 'UPI' | 'OTHER';

  @IsOptional() @IsString() note?: string;

  @IsOptional() @IsEnum(OrderFinancialStatus)
  financialStatus?: OrderFinancialStatus;

  @IsOptional() @IsEnum(OrderFulfillmentStatus)
  fulfillmentStatus?: OrderFulfillmentStatus;

  @IsOptional() @IsBoolean() generateInvoice?: boolean;

  /**
   * The unit prices already include GST, so the tax is taken out of them
   * rather than added on top. Set when completing a draft that was priced
   * that way (a WhatsApp cart from a tax-inclusive store), so the order
   * charges what the draft quoted.
   */
  @IsOptional() @IsBoolean() pricesIncludeTax?: boolean;

  /** Optional ship-to; when omitted, falls back to customer.address. */
  @IsOptional() @IsObject()
  shippingAddress?: Record<string, unknown>;

  /** Optional bill-to; when omitted, falls back to shipping then customer.address. */
  @IsOptional() @IsObject()
  billingAddress?: Record<string, unknown>;
}
