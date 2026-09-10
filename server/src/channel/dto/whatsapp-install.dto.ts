import { IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /channels/whatsapp/install`. Empty for a first connect; carries
 * the channel id when the merchant is re-authorizing an existing row from the
 * Reconnect button.
 */
export class WhatsAppInstallDto {
    @IsOptional()
    @IsString()
    reconnectChannelId?: string;
}
