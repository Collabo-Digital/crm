import { AutomationStatus, ChannelPlatform } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Sort keys are an enum, never a free string (see invoice/dto/query-invoices.dto.ts). */
export enum AutomationSortField {
    updatedAt = 'updatedAt',
    createdAt = 'createdAt',
    name = 'name',
    triggeredCount = 'triggeredCount',
}

export enum SortOrder {
    asc = 'asc',
    desc = 'desc',
}

export class QueryAutomationsDto {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1)
    page?: number = 1;

    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
    limit?: number = 20;

    @IsOptional() @IsEnum(AutomationStatus)
    status?: AutomationStatus;

    @IsOptional() @IsEnum(ChannelPlatform)
    platform?: ChannelPlatform;

    @IsOptional() @IsString() @MaxLength(120)
    search?: string;

    @IsOptional() @IsEnum(AutomationSortField)
    sortBy?: AutomationSortField = AutomationSortField.updatedAt;

    @IsOptional() @IsEnum(SortOrder)
    sortOrder?: SortOrder = SortOrder.desc;
}