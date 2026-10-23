import { IsNotEmpty, IsString } from 'class-validator';

export class MetaPagesCallbackDto {
    @IsString()
    @IsNotEmpty({ message: 'code is required' })
    code: string;

    @IsString()
    @IsNotEmpty({ message: 'state is required' })
    state: string;
}
