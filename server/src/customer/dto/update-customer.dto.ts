import { Type } from 'class-transformer';
import {
    IsArray,
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    Length,
    Matches,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
// The single source of truth for GSTIN shape — this file inlined a copy,
// so a correction to one would silently not reach the other.
import { GSTIN_REGEX } from '../../gst/constants/gst-rates';
import { VipLevel } from '@prisma/client';

/**
 * A customer's saved address, in the snake_case shape Shopify and the order
 * form both write, so slips, invoices and the order form's prefill read it
 * the same way. The service checks the PIN code against the country.
 */
export class CustomerAddressDto {
    @IsOptional() @IsString() @MaxLength(100) first_name?: string;
    @IsOptional() @IsString() @MaxLength(100) last_name?: string;
    @IsOptional() @IsString() @MaxLength(100) company?: string;
    @IsString() @IsNotEmpty({ message: 'Enter the first line of the address.' }) @MaxLength(200) address1: string;
    @IsOptional() @IsString() @MaxLength(200) address2?: string;
    @IsString() @IsNotEmpty({ message: 'Enter the city.' }) @MaxLength(100) city: string;
    @IsOptional() @IsString() @MaxLength(100) province?: string;
    /** The 2-digit GST state code the order form's state picker writes. */
    @IsOptional() @IsString() @Matches(/^\d{2}$/, { message: 'The state code is 2 digits.' }) stateCode?: string;
    @IsString() @IsNotEmpty({ message: 'Enter the PIN or postal code.' }) @MaxLength(12) zip: string;
    @IsOptional() @IsString() @MaxLength(60) country?: string;
    @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/, { message: 'The country code is 2 capital letters, like IN.' }) country_code?: string;
    @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

export class UpdateCustomerDto {
    @IsOptional() @IsEnum(VipLevel) vipLevel?: VipLevel;
    @IsOptional() @IsString() internalNotes?: string;
    @IsOptional() @IsArray() @IsString({ each: true }) segments?: string[];
    @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];

    /** Saved as E.164; an empty string or null clears it. */
    @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(32) phone?: string | null;

    /** Replaces the saved default address. */
    @IsOptional() @ValidateNested() @Type(() => CustomerAddressDto) defaultAddress?: CustomerAddressDto;

    // GST fields — customer's GSTIN for B2B invoicing
    @IsOptional()
    @IsString()
    @Matches(GSTIN_REGEX, {
        message: 'GSTIN must be a valid 15-character GST Identification Number',
    })
    gstin?: string;

    @IsOptional()
    @IsString()
    @Length(2, 2, { message: 'Billing state code must be exactly 2 digits' })
    billingStateCode?: string;

    @IsOptional()
    @IsString()
    billingStateName?: string;
}
