import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApiKeyDto {
    @IsString() @MinLength(2) @MaxLength(60) name!: string;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsString({ each: true }) scopes!: string[];
}

export class CreateWebhookDto {
    @IsString() @MaxLength(1000) url!: string;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) events!: string[];
    @IsOptional() @IsString() @MaxLength(120) description?: string;
}

export class UpdateWebhookDto {
    @IsOptional() @IsString() @MaxLength(1000) url?: string;
    @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) events?: string[];
    @IsOptional() @IsString() @MaxLength(120) description?: string | null;
    @IsOptional() @IsBoolean() enabled?: boolean;
}

// ─── /public/v1 bodies, in the API's snake_case ─────────────────────────────

export class PublicSendMessageDto {
    /** The WhatsApp number, with its country code. */
    @IsString() @MaxLength(32) to!: string;
    @IsOptional() @IsString() @MaxLength(40) channel_id?: string;
    @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) text?: string;
    /** { name, language?, values?: { "1": "…" | "first_name": "…" | "button.0": "…" }, header_url? } */
    @IsOptional() @IsObject() template?: Record<string, unknown>;
}

export class PublicUpsertContactDto {
    @IsString() @MaxLength(32) phone!: string;
    @IsOptional() @IsString() @MaxLength(120) name?: string;
    @IsOptional() @IsString() @MaxLength(40) channel_id?: string;
    @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) tags?: string[];
    @IsOptional() @IsObject() attributes?: Record<string, string>;
    /** true: they agreed to marketing messages (say how in opt_in_evidence); false: they opted out. */
    @IsOptional() @IsBoolean() opt_in?: boolean;
    @IsOptional() @IsString() @MaxLength(300) opt_in_evidence?: string;
}

export class PublicSubscribeDto {
    @IsString() @MaxLength(1000) url!: string;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) events!: string[];
}
