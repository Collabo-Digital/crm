import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsDateString,
    IsEnum,
    IsIn,
    IsInt,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { BroadcastRecipientStatus, BroadcastStatus } from '@prisma/client';

export class SaveTemplateDto {
    /** Validated against TemplateDraftSchema. */
    @IsObject() draft: Record<string, unknown>;
    @IsOptional() @IsString() @MaxLength(60) starterKey?: string;
}

export class QueryTemplatesDto {
    @IsOptional() @IsString() @MaxLength(30) status?: string;
    @IsOptional() @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION']) category?: string;
    @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class SaveSegmentDto {
    @IsString() @MinLength(1) @MaxLength(80) name: string;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) description?: string | null;
    /** Validated against SegmentDefinitionSchema. */
    @IsObject() definition: Record<string, unknown>;
}

export class UpdateSegmentDto {
    @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) description?: string | null;
    @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

export class PreviewSegmentDto {
    @IsObject() definition: Record<string, unknown>;
}

export class SaveBroadcastDto {
    @IsOptional() @IsString() @MaxLength(120) name?: string;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) campaign?: string | null;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() templateId?: string | null;
    /** Validated against BroadcastVariablesSchema. */
    @IsOptional() @IsObject() variables?: Record<string, unknown>;
    /** Validated against BroadcastAudienceSchema. */
    @IsOptional() @IsObject() audience?: Record<string, unknown>;
}

export class QueryBroadcastsDto {
    @IsOptional() @IsEnum(BroadcastStatus) status?: BroadcastStatus;
    @IsOptional() @IsString() @MaxLength(100) search?: string;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
}

export class QueryRecipientsDto {
    @IsOptional() @IsEnum(BroadcastRecipientStatus) status?: BroadcastRecipientStatus;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
}

export class TestSendDto {
    @IsString() @MinLength(8) @MaxLength(20) phone: string;
}

export class ScheduleBroadcastDto {
    /** Omit to send now. */
    @IsOptional() @IsDateString() scheduledAt?: string;
}

export class RateRowDto {
    @IsString() @MinLength(1) @MaxLength(4) countryPrefix: string;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60) label?: string | null;
    @IsString() @MinLength(3) @MaxLength(3) currency: string;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) marketing?: number | null;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) utility?: number | null;
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) authentication?: number | null;
}

export class ReplaceRatesDto {
    @IsArray() @ArrayMaxSize(250) @ValidateNested({ each: true }) @Type(() => RateRowDto) rows: RateRowDto[];
}
