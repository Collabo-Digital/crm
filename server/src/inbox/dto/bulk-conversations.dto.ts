import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export const BULK_ACTIONS = ['assign', 'team', 'close', 'reopen', 'snooze', 'mark_read', 'tag', 'untag'] as const;

export class BulkConversationsDto {
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) ids: string[];
    @IsIn(BULK_ACTIONS) action: (typeof BULK_ACTIONS)[number];
    /** assign: a member id, or null to unassign. */
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() assignedUserId?: string | null;
    /** team: a team id, or null to clear. */
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() teamId?: string | null;
    /** snooze: when the conversations come back. */
    @IsOptional() @IsDateString() snoozedUntil?: string;
    /** tag / untag: the contact tag. */
    @IsOptional() @IsString() @MaxLength(60) tag?: string;
}
