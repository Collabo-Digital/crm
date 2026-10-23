import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class BulkTagContactsDto {
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) ids: string[];
    @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) add?: string[];
    @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) remove?: string[];
}
