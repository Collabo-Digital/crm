import { Controller, Get, Query } from '@nestjs/common';
import { OrgId } from '../../auth/decorators/org-id.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { ORG_MANAGERS, Roles } from '../../auth/decorators/roles.decorator';
import { PosReportsService } from './pos-reports.service';
import { QueryPosActivityDto, QueryPosSummaryDto } from './dto/query-pos-reports.dto';

/**
 * Store reports. Managers only: they show every cashier's takings and every
 * approval and wrong PIN. Vendors never reach them (no `@AllowVendor`).
 */
@RequireSection('orders')
@Roles(...ORG_MANAGERS)
@Controller('pos/reports')
export class PosReportsController {
  constructor(private readonly reports: PosReportsService) { }

  // GET /api/v1/pos/reports/summary?from=2026-10-01&to=2026-10-26&storeId=xxx
  @Get('summary')
  getSummary(@OrgId() orgId: string, @Query() query: QueryPosSummaryDto) {
    return this.reports.getSummary(orgId, query);
  }

  // GET /api/v1/pos/reports/activity?from=2026-10-01&to=2026-10-26&type=approval&limit=50
  @Get('activity')
  getActivity(@OrgId() orgId: string, @Query() query: QueryPosActivityDto) {
    return this.reports.getActivity(orgId, query);
  }
}
