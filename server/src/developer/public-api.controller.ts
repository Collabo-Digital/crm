import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, Caller, RequireApiScope } from './api-key.guard';
import type { ApiCaller } from './api-keys.service';
import { PublicSendMessageDto, PublicSubscribeDto, PublicUpsertContactDto } from './dto/developer.dto';
import { PublicApiService } from './public-api.service';
import { WEBHOOK_EVENTS, WebhooksService } from './webhooks.service';

/**
 * The public API, for other systems: `Authorization: Bearer ck_live_…`.
 * Webhook subscriptions here follow the REST-hook pattern Zapier triggers
 * use: subscribe when a zap is turned on, unsubscribe when it is turned off.
 */
@Controller('public/v1')
@Public()
@UseGuards(ApiKeyGuard)
export class PublicApiController {
    constructor(
        private readonly api: PublicApiService,
        private readonly webhooks: WebhooksService,
    ) { }

    /** Who the key belongs to, for a connection test. */
    @Get('me')
    me(@Caller() caller: ApiCaller) {
        return this.api.me(caller);
    }

    @Post('messages')
    @RequireApiScope('messages:send')
    send(@Caller() caller: ApiCaller, @Body() dto: PublicSendMessageDto, @Headers('idempotency-key') idempotencyKey?: string) {
        const t = dto.template as { name?: unknown; language?: unknown; values?: unknown; header_url?: unknown } | undefined;
        if (t && (typeof t.name !== 'string' || !t.name)) throw new BadRequestException('template.name is required.');
        if (t?.values !== undefined && (typeof t.values !== 'object' || t.values === null || Array.isArray(t.values))) throw new BadRequestException('template.values is an object of strings.');
        return this.api.sendMessage(caller, {
            to: dto.to,
            channelId: dto.channel_id,
            text: dto.text,
            template: t ? { name: t.name as string, language: typeof t.language === 'string' ? t.language : undefined, values: t.values as Record<string, string> | undefined, headerUrl: typeof t.header_url === 'string' ? t.header_url : undefined } : undefined,
        }, idempotencyKey);
    }

    @Post('contacts')
    @RequireApiScope('contacts:write')
    upsertContact(@Caller() caller: ApiCaller, @Body() dto: PublicUpsertContactDto) {
        return this.api.upsertContact(caller, { phone: dto.phone, name: dto.name, channelId: dto.channel_id, tags: dto.tags, attributes: dto.attributes, optIn: dto.opt_in, optInEvidence: dto.opt_in_evidence });
    }

    @Get('contacts')
    @RequireApiScope('contacts:read')
    contacts(@Caller() caller: ApiCaller, @Query('phone') phone?: string) {
        return this.api.findContacts(caller, phone);
    }

    @Get('templates')
    @RequireApiScope('templates:read')
    templates(@Caller() caller: ApiCaller) {
        return this.api.templates(caller);
    }

    @Get('webhooks/events')
    events() {
        return WEBHOOK_EVENTS;
    }

    /** Subscriptions this key made. */
    @Get('webhooks')
    @RequireApiScope('webhooks:manage')
    async subscriptions(@Caller() caller: ApiCaller) {
        return (await this.webhooks.list(caller.organizationId)).filter((w) => w.createdByApi);
    }

    @Post('webhooks')
    @RequireApiScope('webhooks:manage')
    subscribe(@Caller() caller: ApiCaller, @Body() dto: PublicSubscribeDto) {
        return this.webhooks.create(caller.organizationId, { url: dto.url, events: dto.events, description: 'Made through the API', apiKeyId: caller.keyId });
    }

    @Delete('webhooks/:id')
    @RequireApiScope('webhooks:manage')
    @HttpCode(204)
    async unsubscribe(@Caller() caller: ApiCaller, @Param('id') id: string) {
        await this.webhooks.remove(caller.organizationId, id, caller.keyId);
    }
}
