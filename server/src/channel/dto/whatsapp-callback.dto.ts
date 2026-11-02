import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class WhatsAppCallbackDto {
    @IsString()
    @IsNotEmpty({ message: 'code is required' })
    code: string;

    @IsString()
    @IsNotEmpty({ message: 'state is required' })
    state: string;

    // Session info Embedded Signup posted to the page on FINISH. All optional:
    // older flows send none, and the server falls back to asking Meta.
    @IsOptional()
    @IsString()
    @MaxLength(64)
    phoneNumberId?: string;

    /** v4 `waba_id`, or the first of v5 `messaging_account_ids`. */
    @IsOptional()
    @IsString()
    @MaxLength(64)
    wabaId?: string;

    @IsOptional()
    @IsBoolean()
    isOnBizApp?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    businessId?: string;
}
