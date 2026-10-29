import { IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { InboxShareScope } from '@prisma/client';

export class SaveInboxViewDto {
    @IsString() @MinLength(1) @MaxLength(40) name: string;
    /** Validated against ConversationFiltersSchema in the service. */
    @IsObject() filters: Record<string, unknown>;
    @IsEnum(InboxShareScope) scope: InboxShareScope;
    /** Required with TEAM scope. */
    @IsOptional() @IsString() teamId?: string;
    @IsOptional() @IsInt() @Min(0) @Max(1000) position?: number;
}
