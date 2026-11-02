import { IsString, MaxLength } from 'class-validator';

/** What the owner types to delete a workspace. */
export class DeleteOrganizationDto {
    /** The owner's own password, as at sign-in. */
    @IsString()
    @MaxLength(200)
    password: string;

    /** The workspace's name, exactly as shown. */
    @IsString()
    @MaxLength(200)
    confirmName: string;
}
