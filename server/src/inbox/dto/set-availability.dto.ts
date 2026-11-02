import { IsEnum } from 'class-validator';
import { InboxAvailability } from '@prisma/client';

export class SetAvailabilityDto {
    @IsEnum(InboxAvailability) status: InboxAvailability;
}
