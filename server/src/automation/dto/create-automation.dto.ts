import { ChannelPlatform } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body of POST /automations — exactly what the Create dialog asks for. */
export class CreateAutomationDto {
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    /** Only the two channel families the builder supports today. */
    @IsEnum(ChannelPlatform)
    @IsIn([ChannelPlatform.INSTAGRAM, ChannelPlatform.WHATSAPP])
    platform!: ChannelPlatform;

    /** The connected account (Channel row) this automation listens on. */
    @IsString()
    channelId!: string;
}