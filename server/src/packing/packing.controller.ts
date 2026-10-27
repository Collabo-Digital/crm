import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
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
 * stay out: their guards are deny-by-default and nothing here opts in.
 */
@RequirePermissions('inventory.pack')
@Controller('packing')
export class PackingController {
    constructor(private readonly packing: PackingService) { }

    // GET /api/v1/packing/queue?bucket=to_pack&warehouseId=&search=&page=1&limit=25
    @Get('queue')
    @Roles(...ORG_MEMBERS)
    queue(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
        return this.packing.queue(user.orgId!, parsePackingInput(QueueQuerySchema, query, 'list filters'));
    }

    // A packing slip's barcode (the order id) or an exact order name → { orderId }.
    @Get('lookup')
    @Roles(...ORG_MEMBERS)
    lookup(@CurrentUser() user: JwtPayload, @Query('code') code?: string) {
        return this.packing.lookup(user.orgId!, code);
    }

    @Post('orders/:orderId/start')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    start(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
        return this.packing.start(user.orgId!, user.sub, orderId);
    }

    @Get('tasks/:id')
    @Roles(...ORG_MEMBERS)
    task(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.getTask(user.orgId!, id);
    }

    @Post('tasks/:id/scan')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    scan(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        return this.packing.scan(user.orgId!, user.sub, id, parsePackingInput(ScanSchema, body, 'scan'));
    }

    @Post('tasks/:id/lines/:lineId/confirm')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    confirm(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        return this.packing.confirm(user.orgId!, user.sub, id, lineId, parsePackingInput(ConfirmSchema, body, 'confirmation'));
    }

    @Post('tasks/:id/lines/:lineId/count')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    count(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        return this.packing.count(user.orgId!, user.sub, id, lineId, parsePackingInput(CountSchema, body, 'count'));
    }

    @Post('tasks/:id/lines/:lineId/undo')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    undo(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        return this.packing.undo(user.orgId!, user.sub, id, lineId, parsePackingInput(UndoSchema, body, 'undo'));
    }

    @Post('tasks/:id/lines/:lineId/problem')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    problem(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
        return this.packing.setProblem(user.orgId!, user.sub, id, lineId, parsePackingInput(ProblemSchema, body, 'problem'));
    }

    @Delete('tasks/:id/lines/:lineId/problem')
    @Roles(...ORG_OPERATORS)
    clearProblem(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('lineId') lineId: string) {
        return this.packing.clearProblem(user.orgId!, user.sub, id, lineId);
    }

    @Post('tasks/:id/hold')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    hold(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        return this.packing.hold(user.orgId!, user.sub, id, parsePackingInput(HoldSchema, body, 'hold'));
    }

    @Post('tasks/:id/resume')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    resume(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.resume(user.orgId!, user.sub, id);
    }

    @Post('tasks/:id/finish')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    finish(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        return this.packing.finish(user.orgId!, user.sub, id, parsePackingInput(FinishSchema, body, 'finish'));
    }

    // "Start over": cancels a PACKING or ON_HOLD task.
    @Delete('tasks/:id')
    @Roles(...ORG_OPERATORS)
    cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
        return this.packing.cancel(user.orgId!, user.sub, id);
    }

    // GET /api/v1/packing/accuracy?from=2026-10-01&to=2026-10-28&warehouseId=
    @Get('accuracy')
    @Roles(...ORG_MEMBERS)
    @RequirePermissions('inventory.reports')
    accuracy(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
        return this.packing.accuracy(user.orgId!, parsePackingInput(AccuracyQuerySchema, query, 'report filters'));
    }
}
