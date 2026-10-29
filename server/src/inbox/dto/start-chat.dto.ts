import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class StartChatDto {
    /** With its country code, or with `countryCode` beside it. */
    @IsString() @MaxLength(40) phone: string;
    @IsOptional() @IsString() @Matches(/^\d{1,4}$/, { message: 'The country code is 1 to 4 digits, like 91.' }) countryCode?: string;
    @IsOptional() @IsString() @MaxLength(100) name?: string;
    /** The person agreed to hear from the business on WhatsApp. */
    @IsOptional() @IsBoolean() optIn?: boolean;
    /** The store customer this is, from the customer's page. */
    @IsOptional() @IsString() @MaxLength(40) customerId?: string;
}
