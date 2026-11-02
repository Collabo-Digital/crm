import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SaveTeamDto {
    @IsString() @MinLength(1) @MaxLength(60) name: string;
    @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) memberIds?: string[];
}
