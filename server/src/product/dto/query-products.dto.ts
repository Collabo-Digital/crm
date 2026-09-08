import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus } from '@prisma/client';

export class QueryProductsDto {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 20;

    @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
    @IsOptional() @IsString() vendor?: string;
    @IsOptional() @IsString() productType?: string;
    @IsOptional() @IsString() channelId?: string;
    @IsOptional() @IsString() search?: string;
    @IsOptional() @IsString() sortBy?: string = 'createdAt';
    @IsOptional() @IsString() sortOrder?: 'asc' | 'desc' = 'desc';

    // Inventory filters
    @IsOptional() @IsString() stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock';

    /**
     * Restate every variant price in this ISO currency (e.g. "INR").
     *
     * Opt-in, because a catalogue price is normally read in ITS OWN channel's
     * currency and the product screens format it that way. The counter-sale
     * builder is the exception: it prices one order in the org's currency, so
     * it must show — and seed its cart with — the number that will actually be
     * charged. Without this the picker showed a $749.95 Shopify variant as
     * "₹749.95" and put 749.95 into an INR order.
     */
    @IsOptional() @IsString() priceIn?: string;
}