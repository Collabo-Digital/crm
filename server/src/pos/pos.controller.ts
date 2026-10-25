import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { ORG_MANAGERS, ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
import { PosCatalogService } from './pos-catalog.service';
import { PosStaffService } from './pos-staff.service';
import { PosSaleService } from './pos-sale.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosWhatsAppService } from './pos-whatsapp.service';
import { validatePosSettingsPatch } from './pos-settings.schema';
import {
    ApproveSchema,
    CollectPaymentSchema,
    CreateStaffSchema,
    SaleSchema,
    UnlockSchema,
    UpdateStaffSchema,
    parsePosBody,
} from './pos-requests.schema';

/**
 * The point of sale: billing at the counter on top of the offline order. Part
 * of the Orders section; reads and selling for anyone who handles orders,
 * settings and staff for managers. Vendors never reach it.
 */
@RequireSection('orders')
@Controller('pos')
export class PosController {
    constructor(
        private readonly catalog: PosCatalogService,
        private readonly staff: PosStaffService,
        private readonly sales: PosSaleService,
        private readonly receipts: PosReceiptService,
        private readonly whatsapp: PosWhatsAppService,
    ) { }

    // GET /api/v1/pos/setup?storeId= — everything the billing screen loads first.
    @Get('setup')
    @Roles(...ORG_OPERATORS)
    setup(@CurrentUser() user: JwtPayload, @Query('storeId') storeId?: string) {
        return this.catalog.setup(user.orgId!, storeId);
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
        return this.staff.create(user.orgId!, parsePosBody(CreateStaffSchema, body, 'staff member'));
    }

    @Patch('staff/:id')
    @Roles(...ORG_MANAGERS)
    updateStaff(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
        return this.staff.update(user.orgId!, id, parsePosBody(UpdateStaffSchema, body, 'staff member'));
    }

    @Post('unlock')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    unlock(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.staff.unlock(user.orgId!, user.sub, parsePosBody(UnlockSchema, body, 'PIN').pin);
    }

    @Post('approve')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    approve(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.staff.approve(user.orgId!, user.sub, parsePosBody(ApproveSchema, body, 'approval'));
    }

    // GET /api/v1/pos/products?search=&storeId=&limit=20
    @Get('products')
    @Roles(...ORG_OPERATORS)
    products(
        @CurrentUser() user: JwtPayload,
        @Query('search') search?: string,
        @Query('storeId') storeId?: string,
        @Query('limit') limit?: string,
    ) {
        return this.catalog.products(user.orgId!, { search, storeId, limit: limit ? Number(limit) : undefined });
    }

    @Get('scan')
    @Roles(...ORG_OPERATORS)
    scan(@CurrentUser() user: JwtPayload, @Query('code') code?: string, @Query('storeId') storeId?: string) {
        return this.catalog.scan(user.orgId!, code, storeId);
    }

    @Get('customers')
    @Roles(...ORG_OPERATORS)
    customers(@CurrentUser() user: JwtPayload, @Query('search') search?: string) {
        return this.catalog.customers(user.orgId!, search);
    }

    @Post('sales')
    @Roles(...ORG_OPERATORS)
    createSale(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
        return this.sales.createSale(user.orgId!, user.sub, parsePosBody(SaleSchema, body, 'sale'));
    }

    @Post('sales/:orderId/payments')
    @Roles(...ORG_OPERATORS)
    collectPayment(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string, @Body() body: unknown) {
        return this.sales.collectPayment(user.orgId!, user.sub, orderId, parsePosBody(CollectPaymentSchema, body, 'payment'));
    }

    @Get('receipts/:orderId')
    @Roles(...ORG_OPERATORS)
    receipt(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
        return this.receipts.receipt(user.orgId!, orderId);
    }

    @Post('receipts/:orderId/whatsapp')
    @HttpCode(200)
    @Roles(...ORG_OPERATORS)
    sendReceipt(@CurrentUser() user: JwtPayload, @Param('orderId') orderId: string) {
        return this.whatsapp.sendInvoice(user.orgId!, user.sub, orderId);
    }
}
