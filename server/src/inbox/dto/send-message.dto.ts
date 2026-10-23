import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
    /** Validated against the send payload schema in the service. */
    @IsObject() payload: Record<string, unknown>;
    @IsOptional() @IsString() replyToMessageId?: string;
    /** Retrying the same send with the same key sends once. */
    @IsOptional() @IsString() @MaxLength(100) clientId?: string;
}
