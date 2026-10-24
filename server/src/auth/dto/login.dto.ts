import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { NormalizeEmail } from '../../common/utils/email.util';

export class LoginDto {
    @NormalizeEmail()
    @IsEmail()
    email: string;

    @IsString()
    password: string;

    @IsOptional()
    @IsString()
    @Length(6, 6)
    totpCode?: string;
}