import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationHooksService } from './automation-hooks.service';

/**
 * POST /automations/hooks/:token — the URL a webhook trigger hands out. No
 * session: the unguessable token is the credential, and the global rate
 * limit applies. An `Idempotency-Key` header makes a retried call a no-op.
 */
@Controller('automations/hooks')
export class AutomationHooksController {
    constructor(private readonly hooks: AutomationHooksService) { }

    @Post(':token')
    @Public()
    @HttpCode(202)
    receive(@Param('token') token: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
        return this.hooks.receive(token, body, idempotencyKey);
    }
}
