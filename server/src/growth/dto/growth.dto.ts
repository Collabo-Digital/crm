import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGrowthLinkDto {
    @IsString() @MaxLength(40)
    channelId!: string;

    @IsString() @MinLength(2) @MaxLength(80)
    name!: string;

    /** WhatsApp only: the message the chat opens with; the link's reference is added after it. */
    @IsOptional() @IsString() @MaxLength(500)
    prefilledText?: string;

    @IsOptional() @IsString() @MaxLength(60)
    tag?: string;
}

export class UpdateGrowthLinkDto {
    @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
    name?: string;

    @IsOptional() @IsString() @MaxLength(500)
    prefilledText?: string | null;

    @IsOptional() @IsString() @MaxLength(60)
    tag?: string | null;
}

export class SaveWidgetDto {
    @IsString() @MaxLength(40)
    channelId!: string;

    @IsBoolean()
    enabled!: boolean;

    /** Validated against WidgetSettingsSchema in the service. */
    @IsObject()
    settings!: Record<string, unknown>;

    @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(200, { each: true })
    allowedDomains!: string[];
}

/** The pop-up's form, sent form-encoded from the merchant's site. */
export class WidgetSignupDto {
    @IsOptional() @IsString() @MaxLength(32) phone?: string;
    @IsOptional() @IsString() @MaxLength(80) name?: string;
    @IsOptional() @IsString() @MaxLength(10) consent?: string;
    @IsOptional() @IsString() @MaxLength(300) consentText?: string;
    @IsOptional() @IsString() @MaxLength(500) page?: string;
    /** Honeypot: people never see it, bots fill it. */
    @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class WidgetEventDto {
    @IsString() @MaxLength(20) type!: string;
}
