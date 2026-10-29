import { ProductReviewStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ConnectJudgemeDto {
    @IsString() @MaxLength(255) shopDomain!: string;
    @IsString() @MinLength(10) @MaxLength(255) apiToken!: string;
}

export class ListReviewsQuery {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
    @IsOptional() @IsEnum(ProductReviewStatus) status?: ProductReviewStatus;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}
