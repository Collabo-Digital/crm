import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';

/**
 * Body for `POST /organizations/:orgId/invites/influencers`.
 *
 * Deliberately has no required role: the endpoint IS the role. Sending one is
 * tolerated so a mismatch can be refused with a clear message rather than the
 * generic "Validation failed" a whitelist rejection would produce.
 */
export class InviteInfluencerDto {
    // Normalised here so every path stores the same form. Acceptance matches on
    // the stored value and a partial unique index keys on it, so the casing
    // somebody happened to type must not decide either.
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    @IsEmail({}, { message: 'Enter a valid email address' })
    email: string;

    // What to call them before they have an account. Optional: an invitation
    // only needs an address to be valid.
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
    name?: string;

    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole;
}
