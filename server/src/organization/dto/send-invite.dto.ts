import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';

export class SendInviteDto {
    // Normalised here rather than in the service so every caller — invite,
    // re-invite, the onboarding wizard — stores the same form. Acceptance
    // matches on the stored value and a partial unique index keys on it, so
    // the casing someone happened to type must not decide either.
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    @IsEmail({}, { message: 'Enter a valid email address' })
    email: string;

    // What to call the person before they have an account. Optional: an
    // invitation only needs an address to be valid.
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
    name?: string;

    // Which role the invited person will have when they join
    // Cannot be OWNER — validated in the service layer
    @IsEnum(UserRole)
    role: UserRole;

    // For VENDOR invites only: the Product.vendor value to scope the member to.
    // Required + validated against a real vendor in the service layer.
    @IsOptional()
    @IsString()
    vendorScope?: string;
}
