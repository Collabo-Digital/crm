import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsEnum,
    IsIn,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { InboxShareScope } from '@prisma/client';

export class QuickReplyAttachmentDto {
    @IsString() @MaxLength(200) storageKey: string;
    @IsString() @MaxLength(100) mime: string;
    @IsOptional() @IsString() @MaxLength(200) filename?: string;
    @IsIn(['image', 'video', 'audio', 'document']) mediaKind: 'image' | 'video' | 'audio' | 'document';
}

export class SaveQuickReplyDto {
    /** Typed after "/" in the composer: letters, digits, dashes and underscores. */
    @IsString() @MinLength(1) @MaxLength(30) @Matches(/^[a-z0-9_-]+$/i, { message: 'Shortcuts use letters, digits, - and _ only.' })
    shortcut: string;
    @IsString() @MinLength(1) @MaxLength(4096) body: string;
    @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) keywords?: string[];
    @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => QuickReplyAttachmentDto)
    attachment?: QuickReplyAttachmentDto | null;
    @IsEnum(InboxShareScope) scope: InboxShareScope;
    /** Required with TEAM scope. */
    @IsOptional() @IsString() teamId?: string;
}
