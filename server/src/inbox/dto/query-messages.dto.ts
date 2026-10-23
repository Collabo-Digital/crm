import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryMessagesDto {
    /** Cursor: the createdAt and id of the oldest message already shown. */
    @IsOptional() @IsDateString() beforeAt?: string;
    @IsOptional() @IsString() beforeId?: string;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 50;
}
