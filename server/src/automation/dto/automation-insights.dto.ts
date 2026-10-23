import { AutomationRunStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class QueryRunsDto {
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
    page?: number;

    @IsOptional() @IsEnum(AutomationRunStatus)
    status?: AutomationRunStatus;
}

/** Body of POST /automations/:id/test — who to walk the draft for. */
export class TestAutomationDto {
    @IsOptional() @IsString() @MaxLength(40)
    contactId?: string;

    /** The message or comment that "started" it. */
    @IsOptional() @IsString() @MaxLength(1000)
    text?: string;

    /** Their answer at each wait-for-reply; leave out to follow the timeout branch. */
    @IsOptional() @IsString() @MaxLength(1000)
    reply?: string;
}

/** Body of PUT /automations/starters/:channelId; checked with zod in the service. */
export class SaveStartersDto {
    @IsObject()
    starters!: Record<string, unknown>;
}
