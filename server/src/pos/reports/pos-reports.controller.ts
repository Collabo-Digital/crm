import { Controller, Get, Query } from '@nestjs/common';
import { OrgId } from '../../auth/decorators/org-id.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../../auth/interfaces/jwt-payload.interface';
import { locationScopeFor } from '../../auth/location-scope.util';
import { PrismaService } from '../../prisma/prisma.service';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { ORG_MANAGERS, Roles } from '../../auth/decorators/roles.decorator';
import { PosReportsService } from './pos-reports.service';
import { QueryPosActivityDto, QueryPosSummaryDto } from './dto/query-pos-reports.dto';

/**
 * Store reports. Managers only: they show every cashier's takings and every
 * approval and wrong PIN. Vendors never reach them (no `@AllowVendor`). A
 * Manager limited to some stores sees those stores only.
 */
@RequireSection('orders')
@Roles(...ORG_MANAGERS)
@Controller('pos/reports')
export class PosReportsController {
  constructor(
    private readonly reports: PosReportsService,
    private readonly prisma: PrismaService,
  ) { }

  // GET /api/v1/pos/reports/summary?from=2026-10-01&to=2026-10-26&storeId=xxx
  @Get('summary')
  async getSummary(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query() query: QueryPosSummaryDto) {
    return this.reports.getSummary(orgId, query, await locationScopeFor(this.prisma, user));
  }

  // GET /api/v1/pos/reports/activity?from=2026-10-01&to=2026-10-26&type=approval&limit=50
  @Get('activity')
  async getActivity(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query() query: QueryPosActivityDto) {
    return this.reports.getActivity(orgId, query, await locationScopeFor(this.prisma, user));
  }
}
