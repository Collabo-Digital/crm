import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateContactDto {
    @IsOptional() @IsString() @MaxLength(120) displayName?: string;
    @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(60, { each: true }) tags?: string[];
    /** Flat key/value fields; values are strings, numbers or booleans. */
    @IsOptional() @IsObject() attributes?: Record<string, string | number | boolean | null>;
    /** Link to a store customer, or null to unlink. */
    @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() customerId?: string | null;
    @IsOptional() @IsBoolean() blocked?: boolean;
}
