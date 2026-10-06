import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { JwtPayload, SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { canListOrders } from '../auth/permissions';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import {
  ORG_MANAGERS,
  ORG_OPERATORS,
  ORG_OPERATORS_AND_VENDORS,
  Roles,
} from '../auth/decorators/roles.decorator';
import { vendorScopeFor } from '../auth/vendor-scope.util';
import { OrderService } from './order.service';
import { QueryDashboardDto } from '../dashboard/dto/query-dashboard.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { CreateOfflineOrderDto } from './dto/create-offline-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CapturePaymentDto } from './dto/capture-payment.dto';
import { CreateFulfillmentDto } from './dto/create-fulfillment.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { SetItemsStatusDto } from './dto/mark-in-progress.dto';
import type { Response } from 'express';
import {
  EXPORT_ROWS_HEADER,
  EXPORT_TOTAL_HEADER,
} from '../common/utils/export-headers.util';

@RequireSection('orders')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) { }

  // GET /api/v1/orders?page=1&limit=20&financialStatus=PAID&search=1001
  // Also read by customer detail, product detail and the logistics queue.
  @Get()
  @RequireSection('orders', 'customers', 'products', 'logistics')
  @AllowVendor()
  findAll(@CurrentUser() user: SessionPayload, @Query() query: QueryOrdersDto) {
    // Customers / Products members get this list only for one customer or
    // product — never the whole order book.
    if (user.role && !canListOrders(user.role, user.permissions ?? [], query)) {
      throw new ForbiddenException('Section access denied: orders');
    }
    return this.orderService.findAll(user.orgId!, query, vendorScopeFor(user));
  }

  // POST /api/v1/orders/offline — create an offline (in-store) order with
  // optional auto-invoice and inventory decrement.
  @Post('offline')
  @Roles(...ORG_OPERATORS)
  createOffline(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOfflineOrderDto,
  ) {
    return this.orderService.createOfflineOrder(user.orgId!, user.sub, dto);
  }

  // GET /api/v1/orders/stats — MUST be before :id route
  // A vendor gets the same four metrics measured over THEIR line items only;
  // the org-wide method would hand them another vendor's revenue.
  @Get('stats')
  @AllowVendor()
  getStats(@CurrentUser() user: JwtPayload, @Query() query: QueryDashboardDto) {
    const vendorScope = vendorScopeFor(user);
    return vendorScope
      ? this.orderService.getVendorComparison(user.orgId!, query, vendorScope)
      : this.orderService.getComparison(user.orgId!, query);
  }

  // GET /api/v1/orders/export/csv
  // Not called by the app since the Orders page moved to the JSON export
  // (2026-10-06). Kept for API consumers; the page's CSV is the dashboard's.
  @Get('export/csv')
  async exportCsv(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryOrdersDto,
    @Res() res: Response,
  ) {
    const { orders, total } = await this.orderService.getExportData(user.orgId!, query);
    const csv = this.orderService.generateCsv(orders);
    // Lets the page say so when the file holds fewer orders than matched.
    res.setHeader(EXPORT_ROWS_HEADER, String(orders.length));
    res.setHeader(EXPORT_TOTAL_HEADER, String(total));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders-export.csv');
    res.send(csv);
  }

  // GET /api/v1/orders/export/json
  @Get('export/json')
  async exportJson(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryOrdersDto,
    @Res() res: Response,
  ) {
    const { orders: data, total } = await this.orderService.getExportData(user.orgId!, query);
    res.setHeader(EXPORT_ROWS_HEADER, String(data.length));
    res.setHeader(EXPORT_TOTAL_HEADER, String(total));
    const report = {
      generatedAt: new Date().toISOString(),
      filters: {
        financialStatus: query.financialStatus || 'all',
        fulfillmentStatus: query.fulfillmentStatus || 'all',
        dateFrom: query.dateFrom || 'all',
        dateTo: query.dateTo || 'all',
      },
      totalOrders: data.length,
      // Said in the file too, so it still reads correctly away from the page.
      ...(data.length < total && {
        truncated: { ordersIncluded: data.length, ordersMatched: total, order: 'newest first' },
      }),
      orders: data,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=orders-report.json');
    res.send(JSON.stringify(report, null, 2));
  }

  // GET /api/v1/orders/slips/data?orderIds=a,b,c
  // Print payload for the batch package-slip route. MUST stay above the ':id'
  // route — Nest matches in declaration order, so below it "slips" would be
  // read as an order id.
  //
  // Comma-separated ids in one query param, matching GET /inventory/labels/data
  // (no DTO; the parse is three lines and a DTO would only add indirection).
  // No @AllowVendor: a slip carries the customer's full postal address, which
  // vendors have no business printing.
  @Get('slips/data')
  @Roles(...ORG_OPERATORS)
  getSlipData(@CurrentUser() user: JwtPayload, @Query('orderIds') orderIds?: string) {
    const ids = (orderIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.orderService.getSlipData(user.orgId!, ids);
  }

  // GET /api/v1/orders/:id
  @Get(':id')
  @RequireSection('orders', 'customers', 'products', 'logistics')
  @AllowVendor()
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const scope = vendorScopeFor(user);
    return scope
      ? this.orderService.findOneForVendor(id, user.orgId!, scope)
      : this.orderService.findOne(id, user.orgId!);
  }

  // PATCH /api/v1/orders/:id — edit tags / note / email / phone /
  // shipping address / customAttributes. For SHOPIFY orders this fires the
  // `orderUpdate` mutation; for MANUAL orders it just touches the local row.
  @Patch(':id')
  @Roles(...ORG_OPERATORS)
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orderService.update(id, user.orgId!, user.sub, dto);
  }

  // POST /api/v1/orders/:id/cancel — cancel an order with optional refund + restock.
  // Manager+: reverses inventory and the customer's lifetime value.
  @Post(':id/cancel')
  @Roles(...ORG_MANAGERS)
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orderService.cancel(id, user.orgId!, user.sub, dto);
  }

  // POST /api/v1/orders/:id/close — archive a completed order.
  // Reversible via open(), so operators may do it.
  @Post(':id/close')
  @Roles(...ORG_OPERATORS)
  close(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.close(id, user.orgId!, user.sub);
  }

  // POST /api/v1/orders/:id/open — un-archive a previously closed order.
  @Post(':id/open')
  @Roles(...ORG_OPERATORS)
  open(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.open(id, user.orgId!, user.sub);
  }

  // POST /api/v1/orders/:id/mark-paid — flip financial status to PAID.
  // Manager+: asserts money was received.
  @Post(':id/mark-paid')
  @Roles(...ORG_MANAGERS)
  markPaid(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.markPaid(id, user.orgId!, user.sub);
  }

  // POST /api/v1/orders/:id/capture — capture an authorized Shopify payment.
  // Manager+: moves real money.
  @Post(':id/capture')
  @Roles(...ORG_MANAGERS)
  capture(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CapturePaymentDto,
  ) {
    return this.orderService.capture(id, user.orgId!, user.sub, dto);
  }

  // ─── PHASE 2: FULFILLMENT & TRACKING ────────────────────────────────────

  // GET /api/v1/orders/:id/fulfillable-line-items
  // Returns the line items still eligible for fulfillment, grouped by
  // FulfillmentOrder (Shopify) or as a single bucket (manual orders).
  // GET /api/v1/orders/:id/adjacent
  // The ids either side of this order, plus its position, for the detail
  // page's Previous / Next rail.
  @Get(':id/adjacent')
  @AllowVendor()
  adjacent(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.findAdjacent(id, user.orgId!, vendorScopeFor(user));
  }

  // Reads what is left to ship, and only the fulfilment UI consumes it. The
  // RolesGuard is allow-by-default, so without a decorator this was open to
  // every member including VIEWER — match the endpoint it feeds.
  // Deliberately NO @AllowVendor(): VendorAccessGuard keeps this closed to
  // vendors, whose fulfil UI reads their lines from findOneForVendor instead.
  // The scope is still threaded below so that opening it later cannot leak
  // another vendor's lines by omission.
  @Get(':id/fulfillable-line-items')
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  fulfillableLineItems(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.listFulfillableLineItems(
      id,
      user.orgId!,
      vendorScopeFor(user),
    );
  }

  // POST /api/v1/orders/:id/fulfillments
  // Create a fulfillment with optional tracking info.
  @Post(':id/fulfillments')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  createFulfillment(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateFulfillmentDto,
  ) {
    return this.orderService.createFulfillment(id, user.orgId!, user.sub, dto, vendorScopeFor(user));
  }

  // POST /api/v1/orders/:id/items/status — vendor sets their items to in_progress / on_hold.
  @Post(':id/items/status')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  setItemsStatus(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetItemsStatusDto,
  ) {
    return this.orderService.setVendorItemsStatus(
      id,
      user.orgId!,
      user.sub,
      dto.status,
      dto.lineItemIds,
      vendorScopeFor(user),
      dto.reason,
    );
  }

  // POST /api/v1/orders/:id/items/:lineId/delivered — vendor marks ONE product delivered.
  @Post(':id/items/:lineId/delivered')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  markItemDelivered(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orderService.markVendorItemDelivered(
      id,
      user.orgId!,
      user.sub,
      lineId,
      vendorScopeFor(user),
    );
  }

  // POST /api/v1/orders/:id/items/:lineId/unfulfill — vendor switches ONE product back to unfulfilled.
  @Post(':id/items/:lineId/unfulfill')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  unfulfillItem(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orderService.unfulfillVendorItem(
      id,
      user.orgId!,
      user.sub,
      lineId,
      vendorScopeFor(user),
    );
  }

  // PATCH /api/v1/orders/:id/items/:lineId/tracking — add/update tracking for ONE product.
  @Patch(':id/items/:lineId/tracking')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  updateItemTracking(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTrackingDto,
  ) {
    return this.orderService.updateItemTracking(
      id,
      user.orgId!,
      user.sub,
      lineId,
      dto,
      vendorScopeFor(user),
    );
  }

  // PATCH /api/v1/orders/:id/fulfillments/:fid/tracking
  @Patch(':id/fulfillments/:fid/tracking')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  updateTracking(
    @Param('id') id: string,
    @Param('fid') fid: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTrackingDto,
  ) {
    return this.orderService.updateTracking(id, fid, user.orgId!, user.sub, dto, vendorScopeFor(user));
  }

  // POST /api/v1/orders/:id/fulfillments/:fid/delivered — mark a shipment delivered.
  @Post(':id/fulfillments/:fid/delivered')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  markFulfillmentDelivered(
    @Param('id') id: string,
    @Param('fid') fid: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orderService.markFulfillmentDelivered(
      id,
      user.orgId!,
      user.sub,
      fid,
      vendorScopeFor(user),
    );
  }

  // POST /api/v1/orders/:id/fulfillments/:fid/cancel — also the vendor's
  // "switch back to unfulfilled" action (scoped to their own fulfilments).
  @Post(':id/fulfillments/:fid/cancel')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  cancelFulfillment(
    @Param('id') id: string,
    @Param('fid') fid: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orderService.cancelFulfillment(id, fid, user.orgId!, user.sub, vendorScopeFor(user));
  }

  // POST /api/v1/orders/:id/sync — manually push a MANUAL offline order to the
  // connected Shopify store. Idempotent; returns { status, orderId } where
  // status is one of: ALREADY_SYNCED | ALREADY_QUEUED | QUEUED.
  @Post(':id/sync')
  @Roles(...ORG_OPERATORS)
  syncToShopify(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.orderService.syncToShopify(id, user.orgId!, user.sub);
  }
}