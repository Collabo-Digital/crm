import { Controller, Post, Get, Req, Query, Res, Headers, HttpCode, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform } from '@prisma/client';
import { Public } from '../../../auth/decorators/public.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
// import { ContactService } from '../../messaging/contact.service';
// import { MessageService } from '../../messaging/message.service';
// import { AutomationEnqueuer } from '../../automation.enqueuer';
import {
    // InboundItem,
    InstagramWebhookEntry, parseInstagramEntry
} from './instagram-webhook.parser';

@Controller('webhooks')
export class InstagramWebhookController {
    private readonly logger = new Logger(InstagramWebhookController.name);
    private readonly secrets: Array<{ label: string; secret: string }>;
    private readonly verifyToken: string;

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
        // private readonly contacts: ContactService,
        // private readonly messages: MessageService,
        // private readonly enqueuer: AutomationEnqueuer,
    ) {
        this.secrets = [
            { label: 'INSTAGRAM_APP_SECRET', secret: this.config.get<string>('instagram.loginAppSecret') },
            { label: 'META_APP_SECRET', secret: this.config.get<string>('instagram.appSecret') },
        ].filter((s): s is { label: string; secret: string } => !!s.secret);
        this.verifyToken = this.config.get<string>('instagram.webhookVerifyToken')!;
    }

    @Public()
    @Get('instagram')
    verifyWebhook(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
        @Res() res: Response,
    ) {
        if (mode === 'subscribe' && token === this.verifyToken) {
            this.logger.log('Instagram webhook verified');
            return res.status(200).send(challenge);
        }
        this.logger.warn('Instagram webhook verification failed');
        return res.status(403).send('Forbidden');
    }

    @Public()
    @Post('instagram')
    @HttpCode(200)
    async handleWebhook(
        @Req() req: RawBodyRequest<Request>,
        @Headers('x-hub-signature-256') signature: string,
    ) {
        const rawBody = req.rawBody;
        if (!rawBody || !signature) {
            this.logger.warn('Instagram webhook missing body or signature');
            return { received: false };
        }
        const signedWith = this.matchSignature(rawBody, signature);
        if (!signedWith) {
            this.logger.warn('Instagram webhook invalid signature');
            return { received: false };
        }

        let body: { object?: string; entry?: InstagramWebhookEntry[] };
        try {
            body = JSON.parse(rawBody.toString()) as typeof body;
        } catch {
            this.logger.warn('Instagram webhook body is not JSON');
            return { received: false };
        }

        for (const entry of body.entry ?? []) {
            try {
                await this.ingestEntry(entry);
            } catch (err) {
                // Never let one entry turn the whole delivery into a non-200:
                // Meta would redeliver everything and eventually disable us.
                this.logger.error(
                    `Instagram webhook entry ${entry.id} failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        return { received: true };
    }

    /** Which configured secret produced this signature, or null for none. */
    private matchSignature(rawBody: Buffer, signature: string): string | null {
        const received = Buffer.from(signature);
        for (const { label, secret } of this.secrets) {
            const expected = Buffer.from(
                'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
            );
            if (received.length === expected.length && timingSafeEqual(received, expected)) {
                return label;
            }
        }
        return null;
    }

    private async ingestEntry(entry: InstagramWebhookEntry): Promise<void> {
        const channel = await this.prisma.channel.findFirst({
            where: { platform: ChannelPlatform.INSTAGRAM, externalStoreId: entry.id },
            select: { id: true, organizationId: true, status: true, externalStoreId: true },
        });
        if (!channel) {
            this.logger.warn(`Instagram webhook entry ${entry.id}: no matching channel`);
            return;
        }

        const items = parseInstagramEntry(entry, channel);
        for (const item of items) {
            console.log(item);
            // await this.ingestItem(channel, item);
        }
    }

    // private async ingestItem(
    //     channel: { id: string; organizationId: string; externalStoreId: string | null },
    //     item: InboundItem,
    // ): Promise<void> {
    //     const base = {
    //         organizationId: channel.organizationId,
    //         channelId: channel.id,
    //         platform: ChannelPlatform.INSTAGRAM,
    //     };

    //     const contact = await this.contacts.upsertFromInbound(this.prisma, {
    //         ...base,
    //         actor: { externalId: item.actorExternalId, username: item.kind === 'comment' ? item.actorUsername : undefined },
    //         kind: item.kind === 'comment' ? 'comment' : 'message',
    //         at: item.occurredAt,
    //     });

    //     let messageId: string | undefined;
    //     if (item.kind === 'dm') {
    //         const stored = await this.messages.recordInbound({
    //             ...base,
    //             contactId: contact.id,
    //             toAddress: channel.externalStoreId ?? '',
    //             fromAddress: item.actorExternalId,
    //             externalId: item.externalId,
    //             text: item.text,
    //             kind: item.attachments.length ? MessageKindFor(item.attachments[0].type) : undefined,
    //             body: item.raw,
    //             occurredAt: item.occurredAt,
    //         });
    //         if (!stored) return; // redelivery — the event job already exists too
    //         messageId = stored.id;
    //     }

    //     await this.enqueuer.enqueueInboundEvent({
    //         ...base,
    //         eventType: item.kind === 'comment' ? 'instagram.comment' : 'instagram.message',
    //         externalId: item.externalId,
    //         occurredAt: item.occurredAt.toISOString(),
    //         contactId: contact.id,
    //         mediaExternalId: item.kind === 'comment' ? item.mediaExternalId : undefined,
    //         messageId,
    //         actorExternalId: item.actorExternalId,
    //         actorUsername: item.kind === 'comment' ? item.actorUsername : undefined,
    //         text: item.text,
    //         payload: item.raw,
    //     });
    // }
}

/** Instagram attachment type → MessageKind. Keep it small; the schema only has IMAGE for media. */
// function MessageKindFor(type?: string) {
//     return type === 'image' ? ('IMAGE' as const) : ('TEXT' as const);
// }