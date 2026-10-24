import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ChannelPlatform } from '@prisma/client';

export class QueryContactsDto {
    @IsOptional() @IsString() @MaxLength(120) search?: string;
    @IsOptional() @IsEnum(ChannelPlatform) platform?: ChannelPlatform;
    @IsOptional() @IsString() channelId?: string;
    @IsOptional() @IsString() @MaxLength(60) tag?: string;
    /** A member id, or "none" for contacts nobody owns. */
    @IsOptional() @IsString() ownerUserId?: string;
    @IsOptional() @IsString() ownerTeamId?: string;
    @IsOptional() @IsIn(['subscribed', 'no_consent', 'opted_out', 'blocked']) consent?: 'subscribed' | 'no_consent' | 'opted_out' | 'blocked';
    /** First seen on or after / before these dates. */
    @IsOptional() @IsDateString() from?: string;
    @IsOptional() @IsDateString() to?: string;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
    @IsOptional() @IsIn(['createdAt', 'lastInboundAt']) sortBy?: 'createdAt' | 'lastInboundAt' = 'createdAt';
    @IsOptional() @IsIn(['asc', 'desc']) sortOrder?: 'asc' | 'desc' = 'desc';
}
