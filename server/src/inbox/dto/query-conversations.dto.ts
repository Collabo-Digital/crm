import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ChannelPlatform } from '@prisma/client';

export class QueryConversationsDto {
    /** mine = assigned to me · unassigned = the queue · all = everything I may see. */
    @IsOptional() @IsIn(['mine', 'unassigned', 'all']) view?: 'mine' | 'unassigned' | 'all' = 'all';
    /** open includes snoozed conversations whose time has come. */
    @IsOptional() @IsIn(['open', 'snoozed', 'closed', 'any']) status?: 'open' | 'snoozed' | 'closed' | 'any' = 'open';
    @IsOptional() @IsString() channelId?: string;
    @IsOptional() @IsEnum(ChannelPlatform) platform?: ChannelPlatform;
    @IsOptional() @IsString() @MaxLength(60) tag?: string;
    @IsOptional() @IsString() @MaxLength(120) search?: string;
    @IsOptional() @IsIn(['true', 'false']) unread?: 'true' | 'false';
    /** Cursor: the lastMessageAt and id of the last row already shown. */
    @IsOptional() @IsDateString() beforeAt?: string;
    @IsOptional() @IsString() beforeId?: string;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 30;
}
