import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderFinancialStatus, OrderFulfillmentStatus } from '@prisma/client';

export class QueryOrdersDto {
    // Pagination
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 20;

    // Filters
    @IsOptional() @IsEnum(OrderFinancialStatus) financialStatus?: OrderFinancialStatus;
    @IsOptional() @IsEnum(OrderFulfillmentStatus) fulfillmentStatus?: OrderFulfillmentStatus;
    @IsOptional() @IsString() channelId?: string;

    // Payment as the list's Payment column shows it. `cod` and `pending` are
    // both unpaid: cash to collect on delivery, or a prepaid payment still due.
    @IsOptional() @IsIn(['paid', 'pending', 'cod', 'refunded']) payment?: 'paid' | 'pending' | 'cod' | 'refunded';

    // Filter to orders that contain a line item from the given product
    // (used by the product detail page to show "Recent sales").
    @IsOptional() @IsString() productId?: string;
    @IsOptional() @IsString() customerId?: string;

    // Search (by order number, customer name, email or phone)
    @IsOptional() @IsString() search?: string;

    // Sort. Whitelisted: the service spreads this straight into Prisma's
    // `orderBy`, where an unknown column is a 500, not a 400. Scalar columns
    // the list UI offers, and nothing else.
    @IsOptional()
    @IsIn(['externalCreatedAt', 'createdAt', 'totalPrice', 'orderNumber', 'name'])
    sortBy?: string = 'externalCreatedAt';
    @IsOptional() @IsIn(['asc', 'desc']) sortOrder?: 'asc' | 'desc' = 'desc';

    // Date range: a calendar day (`2026-10-01`) or a full ISO instant. `strict`
    // rejects impossible days like `2026-02-30`, which would otherwise reach
    // the query as an Invalid Date and surface as a 500.
    @IsOptional() @IsDateString({ strict: true }) dateFrom?: string;
    @IsOptional() @IsDateString({ strict: true }) dateTo?: string;
}