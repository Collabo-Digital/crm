import { IsDateString, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';

export class UpdateConversationDto {
    @IsOptional() @IsIn(['OPEN', 'CLOSED', 'SNOOZED']) status?: 'OPEN' | 'CLOSED' | 'SNOOZED';
    /** Required with SNOOZED. */
    @IsOptional() @IsDateString() snoozedUntil?: string;
    /** A member id, or null to unassign. */
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() assignedUserId?: string | null;
}
