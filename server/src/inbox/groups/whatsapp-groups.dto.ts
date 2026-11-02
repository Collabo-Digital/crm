import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
    @IsString() @MinLength(1) @MaxLength(40) channelId: string;
    @IsString() @MinLength(1) @MaxLength(128) subject: string;
    @IsOptional() @IsString() @MaxLength(2048) description?: string;
    @IsOptional() @IsIn(['auto_approve', 'approval_required']) joinApprovalMode?: 'auto_approve' | 'approval_required';
}

export class UpdateGroupDto {
    @IsOptional() @IsString() @MinLength(1) @MaxLength(128) subject?: string;
    @IsOptional() @IsString() @MaxLength(2048) description?: string;
}
