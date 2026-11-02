import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { TemplateDraft } from './template-components';

const label = z.string().max(25);

const ButtonSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('QUICK_REPLY'), text: label }),
    z.object({ type: z.literal('URL'), text: label, url: z.string().max(2000), example: z.string().max(200).optional() }),
    z.object({ type: z.literal('PHONE_NUMBER'), text: label, phoneNumber: z.string().max(25) }),
    z.object({ type: z.literal('COPY_CODE'), example: z.string().max(20) }),
]);

const HeaderSchema = z.union([
    z.object({ format: z.literal('TEXT'), text: z.string().max(60), example: z.string().max(200).optional() }),
    z.object({
        format: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
        storageKey: z.string().max(200).optional(),
        mime: z.string().max(100).optional(),
        filename: z.string().max(200).optional(),
    }),
    z.object({ format: z.literal('LOCATION') }),
]);

/** The template editor's request body. Meta's own rules are checked in toMetaComponents. */
export const TemplateDraftSchema = z.object({
    name: z.string().min(1).max(512),
    language: z.string().min(2).max(15),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
    parameterFormat: z.enum(['POSITIONAL', 'NAMED']),
    header: HeaderSchema.optional(),
    body: z.object({ text: z.string().max(1024), examples: z.record(z.string(), z.string().max(200)).default({}) }),
    footer: z.string().max(60).optional(),
    buttons: z.array(ButtonSchema).max(10).optional(),
});

export function parseDraft(raw: unknown): TemplateDraft {
    const parsed = TemplateDraftSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid template: ${issue.path.join('.') || 'template'} — ${issue.message}`);
    }
    return parsed.data as TemplateDraft;
}
