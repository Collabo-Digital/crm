import { IsEmail, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail } from '../../common/utils/email.util';

export class SignupDto {
    @IsString()
    @MinLength(1)
    @MaxLength(50)
    firstName: string;

    @IsString()
    @MinLength(1)
    @MaxLength(50)
    lastName: string;

    @NormalizeEmail()
    @IsEmail()
    email: string;

    @IsString()
    @MinLength(8)
    password: string;

    @IsOptional()
    @IsUrl()
    avatarUrl?: string;
}