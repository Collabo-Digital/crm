import { IsString, MaxLength } from 'class-validator';

/** What the person types to delete their own account. */
export class DeleteAccountDto {
    /** Their password, as at sign-in. */
    @IsString()
    @MaxLength(200)
    password: string;
}
