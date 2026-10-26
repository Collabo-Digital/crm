import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** Body of POST /automations/pack/turn-on. Without keys: every recommended automation that is on by default. */
export class TurnOnPackDto {
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    keys?: string[];
}

/**
 * Body of PUT /automations/pack/cart-discount: the code shoppers type at
 * checkout, what it takes off ("₹200", "10%") and for how many days it is
 * valid. An empty body removes the discount.
 */
export class CartDiscountDto {
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9]{3,20}$/, { message: 'The discount code is 3 to 20 letters and digits.' })
    code?: string;

    @IsOptional()
    @IsString()
    @Matches(/^[^\n\r\t]{1,20}$/, { message: 'Say what the code takes off in 20 characters at most, like ₹200 or 10%.' })
    text?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'The number of days the code is valid is a whole number.' })
    @Min(1, { message: 'The code is valid for 1 to 30 days.' })
    @Max(30, { message: 'The code is valid for 1 to 30 days.' })
    validDays?: number;
}
