import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { DashboardService } from './dashboard.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';
import {
  EXPORT_ROWS_HEADER,
  EXPORT_TOTAL_HEADER,
} from '../common/utils/export-headers.util';

@RequireSection('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) { }

  // GET /api/v1/dashboard?dateFrom=2026-01-01&dateTo=2026-12-31&channelId=xxx
  @Get()
  getOverview(@CurrentUser() user: JwtPayload, @Query() query: QueryDashboardDto) {
    return this.dashboardService.getOverview(user.orgId!, query);
  }

  // GET /api/v1/dashboard/monthly-sales — sales & gross profit, bucketed.
  // Route name kept while the client migrates; the payload is now the source of
  // truth for the stat cards too, not just the chart.
  @Get('monthly-sales')
  getSalesAndProfit(@CurrentUser() user: JwtPayload, @Query() query: QueryDashboardDto) {
    return this.dashboardService.getSalesAndProfit(user.orgId!, query);
  }

  // GET /api/v1/dashboard/sales-by-category — Sales breakdown by product type for donut chart
  @Get('sales-by-category')
  getSalesByCategory(@CurrentUser() user: JwtPayload, @Query() query: QueryDashboardDto) {
    return this.dashboardService.getSalesByCategory(user.orgId!, query);
  }

  // GET /api/v1/dashboard/export/csv — Download orders as CSV
  // The Orders page exports through this endpoint too.
  @Get('export/csv')
  @RequireSection('dashboard', 'orders')
  async exportCsv(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryDashboardDto,
    @Res() res: Response,
  ) {
    const { orders, total } = await this.dashboardService.getReportData(user.orgId!, query);
    const csv = this.dashboardService.generateCsv(orders);

    this.setExportCounts(res, orders.length, total);
    res.setHeader('Content-Type', 'text/csv');
    // Same name the page saves under, for anyone calling the route directly.
    res.setHeader('Content-Disposition', 'attachment; filename=dashboard-report.csv');
    res.send(csv);
  }

  // GET /api/v1/dashboard/export/json — Download orders as JSON report
  @Get('export/json')
  async exportJson(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryDashboardDto,
    @Res() res: Response,
  ) {
    const { overview, orders, period, total } = await this.dashboardService.getExportReport(
      user.orgId!,
      query,
    );

    const exportReport = {
      generatedAt: new Date().toISOString(),
      // The period the rows below actually cover — it used to print "all"
      // above a summary computed over the selected range.
      dateRange: period ?? { from: 'all', to: 'all' },
      summary: {
        totalSales: overview.totalSales,
        totalOrders: overview.totalOrders,
        // Customers first seen inside the window — the "New Customers" card.
        // As `totalCustomers` it read as a contradiction beside a row whose
        // customer was not new.
        newCustomers: overview.totalCustomers,
        totalProducts: overview.totalProducts,
      },
      // Said in the file too, so it still reads correctly once it has left
      // the page that warned about it.
      ...(orders.length < total && {
        truncated: { ordersIncluded: orders.length, ordersMatched: total, order: 'newest first' },
      }),
      orders,
    };

    this.setExportCounts(res, orders.length, total);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=dashboard-export.json');
    res.send(JSON.stringify(exportReport, null, 2));
  }

  /** Lets the page tell the user when the file holds fewer orders than matched. */
  private setExportCounts(res: Response, rows: number, total: number) {
    res.setHeader(EXPORT_ROWS_HEADER, String(rows));
    res.setHeader(EXPORT_TOTAL_HEADER, String(total));
  }
}
