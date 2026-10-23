import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body of PATCH /automations/:id — name and description only. */
export class UpdateAutomationDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;
}