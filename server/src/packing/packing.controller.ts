import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
import { locationScopeFor } from '../auth/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePlanFeature } from '../billing/require-plan-feature.decorator';
import { PackingService } from './packing.service';
import {
    AccuracyQuerySchema,
    ConfirmSchema,
    CountSchema,
    FinishSchema,
    HoldSchema,
    ProblemSchema,
    QueueQuerySchema,
    ScanSchema,
    UndoSchema,
    parsePackingInput,
} from './packing-requests.schema';

const ORG_MEMBERS: UserRole[] = [...ORG_OPERATORS, UserRole.VIEWER];

/**
 * The order packing assistant. Gated on `inventory.pack`, deliberately NOT on
 * the Orders section: a Packer is an AGENT holding inventory.pack and no
 * section.orders, and must reach every route here. Vendors and influencers
 * stay out: their guards are deny-by-default and nothing here opts in. A
 * store-limited packer packs for their own locations (see PackingService).
 */
@RequirePermissions('inventory.pack')
// The packing assistant is on Growth and above (only while plans are enforced).
@RequirePlanFeature('packing')
@Controller('packing')
export class PackingController {
    constructor(
        private readonly packing: PackingService,
        private readonly prisma: PrismaService,
    ) { }

    // GET /api/v1/packing/queue?bucket=to_pack&warehouseId=&search=&page=1&limit=25
    @Get('queue')
    @Roles(...ORG_MEMBERS)
    async queue(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
        const filters = parsePackingInput(QueueQuerySchema, query, 'list filters');
        return this.packing.queue(user.orgId!, filters, await locationScopeFor(this.prisma, user));
    }

    // A packing slip's barcode (the order id) or an exact order name → { orderId }.
    @Get('lookup')
    @Roles(...ORG_MEMBERS)
    async lookup(@CurrentUser() user: JwtPayload, @Query('code') code?: string) {
        return this.packing.lookup(user.orgId!, code, await locationScopeFor(this.prisma, user));
    }

    @Post('orders/:orderId/start')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async start(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
        return this.packing.start(user.orgId!, user.sub, orderId, await locationScopeFor(this.prisma, user));
    }

    @Get('tasks/:id')
    @Roles(...ORG_MEMBERS)
    async task(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.getTask(user.orgId!, id, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/scan')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async scan(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        const input = parsePackingInput(ScanSchema, body, 'scan');
        return this.packing.scan(user.orgId!, user.sub, id, input, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/lines/:lineId/confirm')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async confirm(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        const input = parsePackingInput(ConfirmSchema, body, 'confirmation');
        return this.packing.confirm(user.orgId!, user.sub, id, lineId, input, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/lines/:lineId/count')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async count(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        const input = parsePackingInput(CountSchema, body, 'count');
        return this.packing.count(user.orgId!, user.sub, id, lineId, input, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/lines/:lineId/undo')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async undo(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        const input = parsePackingInput(UndoSchema, body, 'undo');
        return this.packing.undo(user.orgId!, user.sub, id, lineId, input, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/lines/:lineId/problem')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async problem(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        const input = parsePackingInput(ProblemSchema, body, 'problem');
        return this.packing.setProblem(user.orgId!, user.sub, id, lineId, input, await locationScopeFor(this.prisma, user));
    }

    @Delete('tasks/:id/lines/:lineId/problem')
    @Roles(...ORG_OPERATORS)
    async clearProblem(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string) {
        return this.packing.clearProblem(user.orgId!, user.sub, id, lineId, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/hold')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async hold(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        const input = parsePackingInput(HoldSchema, body, 'hold');
        return this.packing.hold(user.orgId!, user.sub, id, input, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/resume')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async resume(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.resume(user.orgId!, user.sub, id, await locationScopeFor(this.prisma, user));
    }

    @Post('tasks/:id/finish')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    async finish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        const input = parsePackingInput(FinishSchema, body, 'finish');
        return this.packing.finish(user.orgId!, user.sub, id, input, await locationScopeFor(this.prisma, user));
    }

    // "Start over": cancels a PACKING or ON_HOLD task.
    @Delete('tasks/:id')
    @Roles(...ORG_OPERATORS)
    async cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.cancel(user.orgId!, user.sub, id, await locationScopeFor(this.prisma, user));
    }

    // GET /api/v1/packing/accuracy?from=2026-10-01&to=2026-10-28&warehouseId=
    @Get('accuracy')
    @Roles(...ORG_MEMBERS)
    @RequirePermissions('inventory.reports')
    async accuracy(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
        const filters = parsePackingInput(AccuracyQuerySchema, query, 'report filters');
        return this.packing.accuracy(user.orgId!, filters, await locationScopeFor(this.prisma, user));
    }
}
