import { IsObject } from 'class-validator';

/** Body of PUT /inbox/settings; checked with zod (inbox-settings.schema.ts). */
export class SaveInboxSettingsDto {
    @IsObject()
    settings!: Record<string, unknown>;
}
