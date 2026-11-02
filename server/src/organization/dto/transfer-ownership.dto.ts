import { IsString, MaxLength, MinLength } from 'class-validator';

/** What the owner sends to hand the workspace to one of its admins. */
export class TransferOwnershipDto {
    /** The user id of the admin who becomes the owner. */
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    newOwnerId: string;

    /** The owner's own password, as at sign-in. */
    @IsString()
    @MaxLength(200)
    password: string;
}
