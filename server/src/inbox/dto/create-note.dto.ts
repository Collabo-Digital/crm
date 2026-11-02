import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateNoteDto {
    @IsString() @MinLength(1) @MaxLength(4000) body: string;
    @IsOptional() @IsArray() @IsString({ each: true }) mentions?: string[];
}
