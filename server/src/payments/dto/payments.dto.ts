import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ConnectRazorpayDto {
    @IsString() @Matches(/^rzp_(live|test)_[A-Za-z0-9]{6,40}$/, { message: 'A Razorpay key id starts with rzp_live_ or rzp_test_.' })
    keyId!: string;

    @IsString() @MinLength(8) @MaxLength(100)
    keySecret!: string;
}

/** One of: an order, a draft order, or an amount with what it is for. */
export class CreatePaymentLinkDto {
    @IsOptional() @IsString() @MaxLength(40)
    orderId?: string;

    @IsOptional() @IsString() @MaxLength(40)
    draftOrderId?: string;

    /** Rupees. Razorpay's smallest link is ₹1; a UPI payment is capped at ₹5,00,000. */
    @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(500000)
    amount?: number;

    @IsOptional() @IsString() @MinLength(2) @MaxLength(200)
    description?: string;

    @IsOptional() @IsInt() @Min(1) @Max(720)
    expiresInHours?: number;
}
