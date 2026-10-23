import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ChannelPlatform } from '@prisma/client';

/** The list filters (see inbox-filters.ts) as query parameters, plus the cursor. */
export class QueryConversationsDto {
    @IsOptional() @IsIn(['mine', 'unassigned', 'all']) view?: 'mine' | 'unassigned' | 'all' = 'all';
    @IsOptional() @IsIn(['open', 'snoozed', 'closed', 'any']) status?: 'open' | 'snoozed' | 'closed' | 'any' = 'open';
    @IsOptional() @IsString() channelId?: string;
    @IsOptional() @IsEnum(ChannelPlatform) platform?: ChannelPlatform;
    @IsOptional() @IsString() @MaxLength(60) tag?: string;
    /** A team id, or "none". */
    @IsOptional() @IsString() teamId?: string;
    @IsOptional() @IsString() assigneeId?: string;
    @IsOptional() @IsString() @MaxLength(120) search?: string;
    @IsOptional() @IsIn(['true', 'false']) unread?: 'true' | 'false';
    @IsOptional() @IsIn(['true', 'false']) comments?: 'true' | 'false';
    /** Cursor: the lastMessageAt and id of the last row already shown. */
    @IsOptional() @IsDateString() beforeAt?: string;
    @IsOptional() @IsString() beforeId?: string;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 30;
}
