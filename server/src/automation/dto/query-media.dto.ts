import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query of GET /automations/media — the trigger step's post picker. */
export class QueryMediaDto {
    /** The connected Instagram account (Channel row). */
    @IsString()
    @IsNotEmpty()
    channelId!: string;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    search?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number = 100;

    /**
     * `?refresh=1` or `?refresh=true` forces a sync. Transformed by hand:
     * implicit conversion would turn the string "false" into true.
     */
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true' || value === '1')
    @IsBoolean()
    refresh?: boolean;
}