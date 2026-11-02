import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { InwardSupplyService } from './inward-supply.service';
import { UpsertInwardSupplyDto } from './dto/upsert-inward-supply.dto';
import { QueryInwardSuppliesDto } from './dto/query-inward-supplies.dto';

// Part of the GST return, on the Invoices page.
@Controller('payment-fees')
@RequireSection('invoices')
export class InwardSupplyController {
  constructor(private readonly paymentFees: InwardSupplyService) {}

  // GET /api/v1/payment-fees?financialYear=2026-27&period=09
  @Get()
  list(@OrgId() orgId: string, @Query() query: QueryInwardSuppliesDto) {
    return this.paymentFees.list(orgId, query);
  }

  // PUT /api/v1/payment-fees — create or correct one supplier's period figure.
  //
  // PUT, not POST: the unique key is (org, year, period, supplier), so this is
  // idempotent by design — re-sending a month's Razorpay total corrects it
  // instead of raising a duplicate that would double the claim.
  //
  // Gated to ORG_MANAGERS like the tax-settings route: these figures feed a
  // tax credit, so they are not something any member should be able to edit.
  @Put()
  @Roles(...ORG_MANAGERS)
  upsert(@OrgId() orgId: string, @Body() dto: UpsertInwardSupplyDto) {
    return this.paymentFees.upsert(orgId, dto);
  }

  @Delete(':id')
  @Roles(...ORG_MANAGERS)
  remove(@OrgId() orgId: string, @Param('id') id: string) {
    return this.paymentFees.remove(orgId, id);
  }
}
