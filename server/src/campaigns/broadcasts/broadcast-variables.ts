import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { ParamValue, TemplateParam } from '../templates/template-components';

/** Where one template value comes from, per recipient. */
export const VariableSourceSchema = z.object({
    source: z.enum(['static', 'first_name', 'full_name', 'phone', 'attribute', 'customer_name', 'customer_email']),
    /** The text for `static`; the attribute key for `attribute`. */
    value: z.string().max(1024).optional(),
    /** Used when the recipient has no value; without one they are skipped. */
    fallback: z.string().max(1024).optional(),
});

export const BroadcastVariablesSchema = z.object({
    /** By template parameter key: header, body.1, body.first_name, button.0, coupon.1. */
    values: z.record(z.string().max(60), VariableSourceSchema).default({}),
    /** The header file, for a template with an image, video or document header. */
    headerMedia: z
        .object({
            storageKey: z.string().min(1).max(200),
            mime: z.string().min(1).max(100),
            kind: z.enum(['image', 'video', 'document']),
            filename: z.string().max(200).optional(),
        })
        .optional(),
    headerLocation: z
        .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: z.string().max(100).optional(), address: z.string().max(300).optional() })
        .optional(),
});

export type VariableSource = z.infer<typeof VariableSourceSchema>;
export type BroadcastVariables = z.infer<typeof BroadcastVariablesSchema>;

export function parseVariables(raw: unknown): BroadcastVariables {
    const parsed = BroadcastVariablesSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid variables: ${issue.path.join('.') || 'variables'} — ${issue.message}`);
    }
    return parsed.data;
}

/** What a recipient brings to the template. */
export interface RecipientContext {
    name: string | null;
    phone: string | null;
    attributes: Record<string, unknown> | null;
    customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
}

function lookup(source: VariableSource, ctx: RecipientContext): string | null {
    const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '') || null;
    switch (source.source) {
        case 'static':
            return clean(source.value);
        case 'first_name':
            return clean(ctx.customer?.firstName) ?? clean(ctx.name?.replace(/^@/, '').split(/\s+/)[0]);
        case 'full_name':
            return clean([ctx.customer?.firstName, ctx.customer?.lastName].filter(Boolean).join(' ')) ?? clean(ctx.name?.replace(/^@/, ''));
        case 'phone':
            return clean(ctx.phone);
        case 'attribute':
            return source.value ? clean(ctx.attributes?.[source.value]) : null;
        case 'customer_name':
            return clean([ctx.customer?.firstName, ctx.customer?.lastName].filter(Boolean).join(' '));
        case 'customer_email':
            return clean(ctx.customer?.email);
    }
}

/**
 * Every template value for one recipient. A value with no source, or with
 * nothing for this recipient and no fallback, is reported as missing.
 */
export function resolveValues(
    params: TemplateParam[],
    vars: BroadcastVariables,
    ctx: RecipientContext,
    headerMediaId?: string | null,
): { values: Record<string, ParamValue>; missing: string[] } {
    const values: Record<string, ParamValue> = {};
    const missing: string[] = [];
    for (const p of params) {
        if (p.component === 'header' && p.kind !== 'text') {
            // The header file is uploaded once per broadcast; its media id is passed in.
            if (p.kind === 'location' && vars.headerLocation) values[p.key] = vars.headerLocation;
            else if (p.kind !== 'location' && headerMediaId) values[p.key] = { mediaId: headerMediaId };
            else missing.push(p.key);
            continue;
        }
        const source = vars.values[p.key];
        const value = source ? (lookup(source, ctx) ?? (source.fallback?.trim() || null)) : null;
        if (value === null) missing.push(p.key);
        else values[p.key] = value;
    }
    return { values, missing };
}

/** Values to check a mapping against before sending: the template's own examples. */
export function exampleContext(): RecipientContext {
    return { name: 'Ananya Rao', phone: '+919800000000', attributes: {}, customer: { firstName: 'Ananya', lastName: 'Rao', email: 'ananya@example.com' } };
}
