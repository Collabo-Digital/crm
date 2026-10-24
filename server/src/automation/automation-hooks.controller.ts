import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationHooksService } from './automation-hooks.service';

/** Each hook URL has its own limit, so callers sharing an address (Zapier, Make) do not share one. */
export const hookTracker = (req: Record<string, any>): string => `automation-hook:${(req.params as { token?: string }).token}`;

/**
 * POST /automations/hooks/:token — the URL a webhook trigger hands out. No
 * session: the unguessable token is the credential, and it is rate limited
 * per token. An `Idempotency-Key` header makes a retried call a no-op.
 */
@Controller('automations/hooks')
export class AutomationHooksController {
    constructor(private readonly hooks: AutomationHooksService) { }

    @Post(':token')
    @Public()
    @HttpCode(202)
    @Throttle({ default: { ttl: 60_000, limit: 600, getTracker: hookTracker } })
    receive(@Param('token') token: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
        return this.hooks.receive(token, body, idempotencyKey);
    }
}
