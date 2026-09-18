import { Controller, Post, Get, Req, Query, Res, Headers, HttpCode, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

interface InstagramWebhookEntry {
    id: string;
    time: number;
    messaging?: Array<{
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number;
        message?: {
            mid?: string;
            is_echo?: boolean;
            reply_to?: { story?: unknown };
            attachments?: Array<{ type?: string }>;
        };
        postback?: unknown;
        read?: unknown;
        reaction?: unknown;
        referral?: unknown;
    }>;
    changes?: Array<{ field: string; value: Record<string, unknown> }>;
}

/** Event kinds in one entry, for logging. Never includes message text. */
function describeEntry(entry: InstagramWebhookEntry): string[] {
    const kinds: string[] = [];
    for (const event of entry.messaging ?? []) {
        if (event.message) {
            const attachment = event.message.attachments?.[0]?.type;
            kinds.push(
                event.message.is_echo
                    ? 'message_echo'
                    : event.message.reply_to?.story
                      ? 'story_reply'
                      : attachment
                        ? `message:${attachment}`
                        : 'message',
            );
        } else if (event.postback) kinds.push('postback');
        else if (event.reaction) kinds.push('reaction');
        else if (event.read) kinds.push('read');
        else if (event.referral) kinds.push('referral');
        else kinds.push('messaging:unknown');
    }
    for (const change of entry.changes ?? []) kinds.push(change.field);
    return kinds;
}

@Controller('webhooks')
export class InstagramWebhookController {
    private readonly logger = new Logger(InstagramWebhookController.name);
    /**
     * Candidate signing secrets. Instagram Login webhooks are expected to be
     * signed with the Instagram app secret, but until a live delivery proves
     * it, the Meta app secret is accepted too and the log says which matched.
     */
    private readonly secrets: Array<{ label: string; secret: string }>;
    private readonly verifyToken: string;

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        this.secrets = [
            { label: 'INSTAGRAM_APP_SECRET', secret: this.config.get<string>('instagram.loginAppSecret') },
            { label: 'META_APP_SECRET', secret: this.config.get<string>('instagram.appSecret') },
        ].filter((s): s is { label: string; secret: string } => !!s.secret);
        this.verifyToken = this.config.get<string>('instagram.webhookVerifyToken')!;
    }

    // GET /webhooks/instagram — Meta webhook verification (challenge-response)
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

    // POST /webhooks/instagram — Receive Instagram events.
    //
    // Diagnostic only for now: proves signatures verify and that each entry
    // routes to a connected channel. Payloads are not stored or acted on yet.
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
            this.logger.warn(
                `Instagram webhook invalid signature (checked ${this.secrets.map((s) => s.label).join(', ') || 'no secrets configured'})`,
            );
            return { received: false };
        }

        let body: { object?: string; entry?: InstagramWebhookEntry[] };
        try {
            body = JSON.parse(rawBody.toString()) as typeof body;
        } catch {
            this.logger.warn('Instagram webhook body is not JSON');
            return { received: false };
        }

        const entries = body.entry ?? [];
        this.logger.log(
            `Instagram webhook object=${body.object} entries=${entries.length} signed with ${signedWith}`,
        );

        for (const entry of entries) {
            const kinds = describeEntry(entry).join(', ') || 'no events';
            try {
                // The routing that inbound processing will rely on: entry.id is
                // the professional account id stored in external_store_id.
                const channel = await this.prisma.channel.findFirst({
                    where: { platform: ChannelPlatform.INSTAGRAM, externalStoreId: entry.id },
                    select: { id: true, status: true },
                });
                this.logger.log(
                    `Instagram webhook entry ${entry.id} → ` +
                    (channel ? `channel ${channel.id} (${channel.status})` : 'NO matching channel') +
                    `: ${kinds}`,
                );
            } catch (err) {
                this.logger.warn(
                    `Instagram webhook entry ${entry.id} (${kinds}): channel lookup failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        return { received: true };
    }
}
