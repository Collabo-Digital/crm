import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductOptionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  values: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  position?: number;
}

export class UpdateOptionsDto {
  @IsArray()
  @ArrayMaxSize(3)
  @Type(() => ProductOptionDto)
  options: ProductOptionDto[];
}
