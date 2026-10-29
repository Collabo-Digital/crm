import { IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /channels/instagram/install`.
 *
 * Instagram OAuth needs no user input (unlike Shopify's shopDomain) — the
 * merchant clicks Connect and picks the account inside Facebook Login. The one
 * optional field says "re-authorize THIS channel" rather than "add another",
 * which is what the Reconnect button on an errored or expired row sends.
 */
export class ConnectInstagramDto {
    @IsOptional()
    @IsString()
    reconnectChannelId?: string;
}
