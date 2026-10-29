import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '../../common/utils/email.util';

export class ForgotPasswordDto {
    @NormalizeEmail()
    @IsEmail()
    email: string;
}