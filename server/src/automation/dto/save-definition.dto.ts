import { IsIn, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AutomationSettingsDto {
    @IsOptional()
    @IsIn(['ever', 'perDay', 'never'])
    oncePerContact?: 'ever' | 'perDay' | 'never';
}

/**
 * Body of PUT /automations/:id/definition. The step list is typed loosely
 * here on purpose: the global ValidationPipe guards the envelope, and the
 * block registry (blocks/definition.schema.ts) validates the steps with zod.
 */
export class SaveDefinitionDto {
    @IsObject()
    definition!: { steps: unknown[] };

    @IsOptional()
    @ValidateNested()
    @Type(() => AutomationSettingsDto)
    settings?: AutomationSettingsDto;
}