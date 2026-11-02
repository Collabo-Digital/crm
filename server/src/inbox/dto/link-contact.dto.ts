import { IsString, MaxLength } from 'class-validator';

/** Another chat contact: the same person on another number or profile, or a chat to link to a customer. */
export class LinkContactDto {
    @IsString() @MaxLength(40) contactId: string;
}
