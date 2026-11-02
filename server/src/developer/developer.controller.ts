import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { API_SCOPES, ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto, CreateWebhookDto, UpdateWebhookDto } from './dto/developer.dto';
import { WEBHOOK_EVENTS, WebhooksService } from './webhooks.service';

/** Keys and webhooks act for the whole organization: owners and admins. */
const OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/** Settings → Developers: API keys and outgoing webhooks. */
@Controller('developers')
@Roles(...OWNERS)
export class DeveloperController {
    constructor(
        private readonly keys: ApiKeysService,
        private readonly webhooks: WebhooksService,
    ) { }

    @Get('catalog')
    catalog() {
        return { scopes: API_SCOPES, events: WEBHOOK_EVENTS };
    }

    @Get('keys')
    listKeys(@CurrentUser() user: SessionPayload) {
        return this.keys.list(user.orgId!);
    }

    @Post('keys')
    createKey(@CurrentUser() user: SessionPayload, @Body() dto: CreateApiKeyDto) {
        return this.keys.create(user.orgId!, user.sub, dto);
    }

    @Delete('keys/:id')
    @HttpCode(204)
    async revokeKey(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        await this.keys.revoke(user.orgId!, id);
    }

    @Get('webhooks')
    listWebhooks(@CurrentUser() user: SessionPayload) {
        return this.webhooks.list(user.orgId!);
    }

    @Post('webhooks')
    createWebhook(@CurrentUser() user: SessionPayload, @Body() dto: CreateWebhookDto) {
        return this.webhooks.create(user.orgId!, { ...dto, createdById: user.sub });
    }

    @Patch('webhooks/:id')
    updateWebhook(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
        return this.webhooks.update(user.orgId!, id, dto);
    }

    @Delete('webhooks/:id')
    @HttpCode(204)
    async removeWebhook(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        await this.webhooks.remove(user.orgId!, id);
    }

    @Post('webhooks/:id/rotate-secret')
    rotate(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.webhooks.rotateSecret(user.orgId!, id);
    }

    @Post('webhooks/:id/test')
    test(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.webhooks.test(user.orgId!, id);
    }

    @Get('webhooks/:id/deliveries')
    deliveries(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.webhooks.deliveries(user.orgId!, id);
    }
}
