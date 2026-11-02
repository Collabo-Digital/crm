import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { JwtPayload, SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { resolveSections } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { locationScopeFor } from '../auth/location-scope.util';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSection, SectionOrPermission } from '../auth/decorators/require-section.decorator';
import { ORG_MANAGERS, ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
import { PosCatalogService } from './pos-catalog.service';
import { PosStaffService } from './pos-staff.service';
import { PosSaleService } from './pos-sale.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosBillService } from './pos-bill.service';
import { validatePosSettingsPatch } from './pos-settings.schema';
import {
    ApproveSchema,
    CollectPaymentSchema,
    CreateStaffSchema,
    SaleSchema,
    SendBillSchema,
    UnlockSchema,
    UpdateStaffSchema,
    parsePosBody,
} from './pos-requests.schema';

/**
 * Reached the till through `pos.sell` alone, without the Orders section: a
 * Cashier, whose receipts are those of counter sales and never another order's.
 */
function tillOnly(user: SessionPayload): boolean {
    const sections = resolveSections(user.role!, user.permissions ?? []);
    return sections !== 'all' && !sections.has('section.orders');
}

/**
 * The point of sale: billing at the counter on top of the offline order. Part
 * of the Orders section; reads and selling for anyone who handles orders,
 * settings and staff for managers. Vendors never reach it. A Manager or Agent
 * limited to some stores sees and bills at those only
 * (auth/location-scope.util).
 *
 * The till's own routes also open to `pos.sell` without the Orders section,
 * so a Cashier sells without seeing the order book. Everything else here
 * (settings, staff) does not.
 */
@RequireSection('orders')
@Controller('pos')
export class PosController {
    constructor(
        private readonly catalog: PosCatalogService,
        private readonly staff: PosStaffService,
        private readonly sales: PosSaleService,
        private readonly receipts: PosReceiptService,
        private readonly bills: PosBillService,
        private readonly prisma: PrismaService,
    ) { }

    // GET /api/v1/pos/setup?storeId= — everything the billing screen loads first.
    @Get('setup')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async setup(@CurrentUser() user: JwtPayload, @Query('storeId') storeId?: string) {
        const scope = await locationScopeFor(this.prisma, user);
        const [setup, billDelivery] = await Promise.all([this.catalog.setup(user.orgId!, storeId, scope), this.bills.setup(user.orgId!)]);
        return { ...setup, billDelivery };
    }

    @Patch('settings')
    @Roles(...ORG_MANAGERS)
    updateSettings(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.catalog.updateSettings(user.orgId!, validatePosSettingsPatch(body));
    }

    // Every staff member, switched off ones too, for the manager's list.
    @Get('staff')
    @Roles(...ORG_MANAGERS)
    listStaff(@CurrentUser() user: JwtPayload) {
        return this.staff.list(user.orgId!, true);
    }

    @Post('staff')
    @Roles(...ORG_MANAGERS)
    createStaff(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.staff.create(user.orgId!, user.sub, parsePosBody(CreateStaffSchema, body, 'staff member'));
    }

    @Patch('staff/:id')
    @Roles(...ORG_MANAGERS)
    updateStaff(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        return this.staff.update(user.orgId!, user.sub, id, parsePosBody(UpdateStaffSchema, body, 'staff member'));
    }

    @Post('unlock')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async unlock(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        const { pin, storeId } = parsePosBody(UnlockSchema, body, 'PIN');
        // A store-limited member opens the till at one of their own stores only.
        const scope = await locationScopeFor(this.prisma, user);
        if (scope) await this.catalog.resolveStore(user.orgId!, storeId, scope);
        return this.staff.unlock(user.orgId!, user.sub, pin, storeId);
    }

    @Post('approve')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    approve(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.staff.approve(user.orgId!, user.sub, parsePosBody(ApproveSchema, body, 'approval'));
    }

    // GET /api/v1/pos/products?search=&storeId=&limit=20
    @Get('products')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async products(
        @CurrentUser() user: JwtPayload,
        @Query('search') search?: string,
        @Query('storeId') storeId?: string,
        @Query('limit') limit?: string,
    ) {
        const scope = await locationScopeFor(this.prisma, user);
        return this.catalog.products(user.orgId!, { search, storeId, limit: limit ? Number(limit) : undefined }, scope);
    }

    @Get('scan')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async scan(@CurrentUser() user: JwtPayload, @Query('code') code?: string, @Query('storeId') storeId?: string) {
        return this.catalog.scan(user.orgId!, code, storeId, await locationScopeFor(this.prisma, user));
    }

    @Get('customers')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    customers(@CurrentUser() user: JwtPayload, @Query('search') search?: string) {
        return this.catalog.customers(user.orgId!, search);
    }

    @Post('sales')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async createSale(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        const input = parsePosBody(SaleSchema, body, 'sale');
        return this.sales.createSale(user.orgId!, user.sub, input, await locationScopeFor(this.prisma, user));
    }

    @Post('sales/:orderId/payments')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async collectPayment(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string, @Body() body: unknown) {
        const input = parsePosBody(CollectPaymentSchema, body, 'payment');
        return this.sales.collectPayment(user.orgId!, user.sub, orderId, input, await locationScopeFor(this.prisma, user));
    }

    // Where the bill's sending stands, for the screen after a sale to follow.
    @Get('sales/:orderId/delivery')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    delivery(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
        return this.bills.view(user.orgId!, orderId);
    }

    @Post('sales/:orderId/send-bill')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    async sendBill(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string, @Body() body: unknown) {
        const input = parsePosBody(SendBillSchema, body, 'bill to send');
        return this.bills.sendAgain(user.orgId!, user.sub, orderId, input, await locationScopeFor(this.prisma, user));
    }

    @Get('receipts/:orderId')
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    receipt(@CurrentUser() user: SessionPayload, @Param('orderId') orderId: string) {
        return this.receipts.receipt(user.orgId!, orderId, { posSaleOnly: tillOnly(user) });
    }

    // After the receipt prints: the first print is recorded, so a reprint says DUPLICATE.
    @Post('receipts/:orderId/printed')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    @SectionOrPermission('pos.sell')
    receiptPrinted(@CurrentUser() user: SessionPayload, @Param('orderId') orderId: string) {
        return this.receipts.markPrinted(user.orgId!, orderId, { posSaleOnly: tillOnly(user) });
    }
}
