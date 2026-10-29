import { Controller, Get, Post, Req, Query, Res, Headers, HttpCode, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../auth/decorators/public.decorator';
import { MetaWebhookIntakeService } from './meta-webhook-intake.service';
import type { MetaWebhookObject } from './meta-inbound.queue';

interface HubQuery {
    mode?: string;
    token?: string;
    challenge?: string;
}

/**
 * The three Meta webhook callbacks. One per product, because the App
 * Dashboard configures WhatsApp, Messenger (object `page`) and Instagram each
 * with its own callback URL and verify token.
 *
 * Every POST answers 200 whatever happens to the payload afterwards: a
 * non-200 makes Meta retry for up to 7 days and, for Messenger and Instagram,
 * unsubscribe the app after an hour of failures. Only the signature decides
 * whether a body is stored at all.
 */
@Controller('webhooks')
@SkipThrottle()
export class MetaWebhookController {
    private readonly logger = new Logger(MetaWebhookController.name);
    private readonly verifyTokens: Record<MetaWebhookObject, string | undefined>;

    constructor(
        config: ConfigService,
        private readonly intake: MetaWebhookIntakeService,
    ) {
        this.verifyTokens = {
            whatsapp_business_account: config.get<string>('whatsapp.webhookVerifyToken'),
            page: config.get<string>('messenger.webhookVerifyToken'),
            instagram: config.get<string>('instagram.webhookVerifyToken'),
        };
    }

    @Public()
    @Get('whatsapp')
    verifyWhatsApp(@Query() q: Record<string, string>, @Res() res: Response) {
        return this.verify('whatsapp_business_account', hub(q), res);
    }

    @Public()
    @Post('whatsapp')
    @HttpCode(200)
    receiveWhatsApp(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
        return this.receive('whatsapp_business_account', req, signature);
    }

    @Public()
    @Get('messenger')
    verifyMessenger(@Query() q: Record<string, string>, @Res() res: Response) {
        return this.verify('page', hub(q), res);
    }

    @Public()
    @Post('messenger')
    @HttpCode(200)
    receiveMessenger(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
        return this.receive('page', req, signature);
    }

    @Public()
    @Get('instagram')
    verifyInstagram(@Query() q: Record<string, string>, @Res() res: Response) {
        return this.verify('instagram', hub(q), res);
    }

    @Public()
    @Post('instagram')
    @HttpCode(200)
    receiveInstagram(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
        return this.receive('instagram', req, signature);
    }

    private verify(object: MetaWebhookObject, q: HubQuery, res: Response) {
        const expected = this.verifyTokens[object];
        if (q.mode === 'subscribe' && expected && q.token === expected) {
            this.logger.log(`Meta ${object} webhook verified`);
            return res.status(200).send(q.challenge ?? '');
        }
        this.logger.warn(`Meta ${object} webhook verification failed`);
        return res.status(403).send('Forbidden');
    }

    private async receive(object: MetaWebhookObject, req: RawBodyRequest<Request>, signature?: string) {
        const outcome = await this.intake.accept(object, req.rawBody, signature);
        return { received: outcome === 'stored' || outcome === 'redelivery' };
    }
}

/** Express parses `hub.mode` into a nested `hub` object or a dotted key depending on the query parser. */
function hub(q: Record<string, unknown>): HubQuery {
    const nested = q.hub && typeof q.hub === 'object' ? (q.hub as Record<string, string>) : {};
    return {
        mode: (q['hub.mode'] as string | undefined) ?? nested.mode,
        token: (q['hub.verify_token'] as string | undefined) ?? nested.verify_token,
        challenge: (q['hub.challenge'] as string | undefined) ?? nested.challenge,
    };
}
