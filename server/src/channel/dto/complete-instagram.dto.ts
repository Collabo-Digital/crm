import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for `POST /channels/instagram/complete` — the merchant's answer when one
 * Facebook login granted several Instagram accounts and they had to pick.
 */
export class CompleteInstagramDto {
    /** Opaque id of the parked selection, handed out by the OAuth callback. */
    @IsString()
    @IsNotEmpty({ message: 'pendingId is required' })
    pendingId: string;

    /** Instagram business account id of the chosen candidate. */
    @IsString()
    @IsNotEmpty({ message: 'igUserId is required' })
    igUserId: string;
}
