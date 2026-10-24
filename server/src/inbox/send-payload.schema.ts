import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { OutboundPayload } from '../messaging/outbound';

const text = z.string().trim().min(1).max(4096);
const option = z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(24) });

/**
 * What the inbox composer may send. Platform limits beyond shape (window,
 * button counts per platform, Instagram's byte limit) are the send gate's.
 */
const SendPayloadSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text, previewUrl: z.boolean().optional() }),
    z.object({
        type: z.literal('media'),
        mediaKind: z.enum(['image', 'video', 'audio', 'document']),
        storageKey: z.string().min(1).max(200),
        mime: z.string().min(1).max(100),
        filename: z.string().max(200).optional(),
        caption: z.string().max(1024).optional(),
    }),
    z.object({
        type: z.literal('template'),
        name: z.string().regex(/^[a-z0-9_]+$/).max(512),
        language: z.string().min(2).max(15),
        components: z.array(z.unknown()).max(20).optional(),
        category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
        headerMedia: z
            .object({
                storageKey: z.string().min(1).max(200),
                mime: z.string().min(1).max(100),
                kind: z.enum(['image', 'video', 'document']),
                filename: z.string().max(200).optional(),
            })
            .optional(),
        previewText: z.string().max(1100).optional(),
    }),
    z.object({ type: z.literal('buttons'), text, buttons: z.array(option).min(1).max(3), footer: z.string().max(60).optional() }),
    z.object({
        type: z.literal('list'),
        text,
        buttonText: z.string().min(1).max(20),
        sections: z
            .array(z.object({ title: z.string().max(24).optional(), rows: z.array(option.extend({ description: z.string().max(72).optional() })).min(1).max(10) }))
            .min(1)
            .max(10),
    }),
    z.object({
        type: z.literal('quick_replies'),
        text,
        replies: z.array(z.object({ title: z.string().min(1).max(20), payload: z.string().min(1).max(1000) })).min(1).max(13),
    }),
    z.object({
        type: z.literal('location'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().max(100).optional(),
        address: z.string().max(300).optional(),
    }),
    /** The composer names our message row; the service resolves its platform id. */
    z.object({ type: z.literal('reaction'), messageId: z.string().min(1), emoji: z.string().max(16) }),
    z.object({ type: z.literal('private_reply'), commentMessageId: z.string().min(1), text }),
    /** A public reply under an Instagram or Facebook comment. */
    z.object({ type: z.literal('comment_reply'), commentMessageId: z.string().min(1), text: z.string().trim().min(1).max(2000) }),
    /** WhatsApp: one product, or a list of up to 30, from the number's catalog. */
    z.object({
        type: z.literal('products'),
        variantIds: z.array(z.string().min(1).max(40)).min(1).max(30),
        header: z.string().trim().max(60).optional(),
        text: z.string().trim().max(1024).optional(),
        /** 2 to 10 products as swipeable cards instead of a list. */
        format: z.enum(['list', 'cards']).optional(),
    }),
    /** WhatsApp: a button that opens the whole catalog. */
    z.object({ type: z.literal('catalog'), text: z.string().trim().min(1).max(1024) }),
]);

export type SendPayloadInput = z.infer<typeof SendPayloadSchema>;

export function parseSendPayload(raw: unknown): SendPayloadInput {
    const parsed = SendPayloadSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid message: ${issue.path.join('.') || 'payload'} — ${issue.message}`);
    }
    return parsed.data;
}

/** The payload types that pass straight through to the send service. */
export function asOutbound(input: Exclude<SendPayloadInput, { type: 'reaction' | 'private_reply' | 'comment_reply' | 'products' }>): OutboundPayload {
    return input as OutboundPayload;
}
