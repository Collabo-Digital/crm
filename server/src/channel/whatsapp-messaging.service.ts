import { Injectable, Logger } from '@nestjs/common';
import { ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from './encryption.service';
import { MetaGraphClient } from './meta-graph.client';
import { MetaGraphError, metaScope } from './meta-graph.types';
import { Priority, isRateLimitedError } from '../rate-limit/rate-limit.types';
import type { WhatsAppMessageJobData } from './whatsapp.queue';

/**
 * Meta error codes that should NOT be retried (job should fail permanently).
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/
 */
const NON_RETRYABLE_ERROR_CODES = new Set<number>([
    190, // OAuthException — token expired / revoked
    132, // Template does not exist or is not approved
    131009, // Parameter value invalid (bad phone format)
    131026, // Message undeliverable (recipient not on WhatsApp)
    131047, // Re-engagement required (24-hour window expired and no approved template)
    131051, // Unsupported message type
]);

interface WhatsAppChannelCredentials {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string; // encrypted
    [key: string]: unknown;
}

interface MetaSendResponse {
    messaging_product: string;
    contacts?: Array<{ input: string; wa_id: string }>;
    messages?: Array<{ id: string; message_status?: string }>;
}

/**
 * Sends template messages to customers via Meta's WhatsApp Cloud API.
 *
 * Responsibilities:
 *   • Decrypt the merchant's access token from Channel.credentials
 *   • Insert a WhatsAppMessageLog row with status=queued BEFORE the API call
 *     (so every attempt is auditable even if the process crashes mid-request)
 *   • POST to graph.facebook.com/.../{phoneNumberId}/messages through the
 *     shared MetaGraphClient, which paces against the app, WABA and
 *     phone-number wallets and reads Meta's usage headers on the way back
 *   • Update the log row with status=sent (+ externalId) or status=failed
 *   • Re-throw for retry-worthy errors so BullMQ can retry with backoff; a
 *     rate limit leaves the row `queued` and is re-thrown so the processor
 *     parks the job instead of burning an attempt.
 */
@Injectable()
export class WhatsAppMessagingService {
    private readonly logger = new Logger(WhatsAppMessagingService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly metaGraph: MetaGraphClient,
    ) {}

    async sendTemplate(data: WhatsAppMessageJobData): Promise<void> {
        const channel = await this.prisma.channel.findUnique({ where: { id: data.channelId } });
        if (!channel || !channel.credentials) {
            throw new Error(`WhatsApp channel ${data.channelId} not found or missing credentials`);
        }
        const creds = channel.credentials as unknown as WhatsAppChannelCredentials;
        const accessToken = this.encryption.decrypt(creds.accessToken);
        const phoneNumberId = creds.phoneNumberId;

        const requestBody = {
            messaging_product: 'whatsapp',
            to: data.toPhone,
            type: 'template',
            template: {
                name: data.templateName,
                language: { code: data.templateLanguage },
            },
        };

        // Insert an audit row BEFORE the API call. If the process dies mid-request,
        // we still have a record of the attempt.
        const log = await this.prisma.whatsAppMessageLog.create({
            data: {
                organizationId: data.organizationId,
                channelId: data.channelId,
                customerId: data.customerId ?? null,
                orderId: data.orderId ?? null,
                templateName: data.templateName,
                templateLanguage: data.templateLanguage,
                triggerType: data.triggerType,
                toPhone: data.toPhone,
                status: 'queued',
                requestPayload: requestBody,
            },
        });

        // Three wallets, broad to specific: the app every merchant shares,
        // this merchant's WhatsApp business account, and this phone number's
        // messages-per-second cap. All three must have room.
        const scopes = [
            ...this.metaGraph.baseScopes(),
            ...(creds.wabaId ? [metaScope.buc(creds.wabaId)] : []),
            metaScope.phone(phoneNumberId),
        ];

        let responseBody: MetaSendResponse;
        try {
            const res = await this.metaGraph.request<MetaSendResponse>({
                method: 'POST',
                path: `/${phoneNumberId}/messages`,
                accessToken,
                body: requestBody,
                scopes,
                // A customer is owed this message now.
                priority: Priority.INTERACTIVE,
                channelId: data.channelId,
            });
            responseBody = res.data;
        } catch (err) {
            if (isRateLimitedError(err)) {
                // Not a failure: the row stays queued and the processor parks
                // the job until the wallet reopens.
                await this.prisma.whatsAppMessageLog.update({
                    where: { id: log.id },
                    data: {
                        errorCode: 'RATE_LIMITED',
                        errorMessage: `Paused until ${new Date(err.retryAtMs).toISOString()} (${err.reason})`,
                    },
                });
                throw err;
            }

            const meta = err instanceof MetaGraphError ? err : null;
            const code = meta?.metaCode ?? meta?.httpStatus;
            const message = err instanceof Error ? err.message : String(err);

            await this.prisma.whatsAppMessageLog.update({
                where: { id: log.id },
                data: {
                    status: 'failed',
                    errorCode: code !== undefined ? String(code) : (meta?.code ?? 'ERROR'),
                    errorMessage: message,
                    responsePayload: (meta?.details as object | undefined) ?? undefined,
                    failedAt: new Date(),
                },
            });

            // Special handling: auth errors mean the merchant's token is dead — mark
            // channel as ERROR so the UI surfaces that they need to reconnect.
            if (meta?.code === 'AUTH_FAILED') {
                await this.prisma.channel.update({
                    where: { id: data.channelId },
                    data: {
                        status: ChannelStatus.ERROR,
                        lastError: 'WhatsApp access expired or was revoked. Reconnect the number.',
                    },
                });
                this.logger.warn(
                    `WhatsApp channel ${data.channelId} token expired/revoked; marked ERROR`,
                );
                return;
            }

            this.logger.error(
                `WhatsApp send failed (code=${code ?? meta?.code}): ${message} for ${data.toPhone}`,
            );

            // Re-throw only for retry-worthy errors. Non-retryable errors have already
            // been logged as `failed`; throwing would just burn retries on a guaranteed failure.
            if (code !== undefined && NON_RETRYABLE_ERROR_CODES.has(Number(code))) return;
            throw err;
        }

        const externalId = responseBody.messages?.[0]?.id;
        if (!externalId) {
            await this.prisma.whatsAppMessageLog.update({
                where: { id: log.id },
                data: {
                    status: 'failed',
                    errorCode: 'NO_MESSAGE_ID',
                    errorMessage: 'Meta accepted the request but returned no message id',
                    responsePayload: responseBody as object,
                    failedAt: new Date(),
                },
            });
            throw new Error('WhatsApp send returned no message id');
        }

        await this.prisma.whatsAppMessageLog.update({
            where: { id: log.id },
            data: {
                status: 'sent',
                externalId,
                responsePayload: responseBody as object,
                sentAt: new Date(),
            },
        });
        this.logger.log(
            `WhatsApp ${data.templateName} sent to ${data.toPhone} (wamid=${externalId})`,
        );
    }
}
