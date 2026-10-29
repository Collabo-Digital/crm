import { Controller, ForbiddenException, Get, Patch, Param, Query, Body } from '@nestjs/common';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { Roles, ORG_MANAGERS, ORG_OPERATORS } from '../auth/decorators/roles.decorator';
import { CustomerService } from './customer.service';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@RequireSection('customers')
@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) { }

  // Also read by the order form's customer picker and order detail.
  @Get()
  @RequireSection('customers', 'orders')
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryCustomersDto) {
    return this.customerService.findAll(user.orgId!, query);
  }

  @Get('tags')
  getTags(@CurrentUser() user: JwtPayload) {
    return this.customerService.getTags(user.orgId!);
  }

  @Get('segments')
  getSegments(@CurrentUser() user: JwtPayload) {
    return this.customerService.getSegments(user.orgId!);
  }

  // GET /api/v1/customers/stats — PLACE BEFORE :id route
  @Get('stats')
  getStats(@CurrentUser() user: JwtPayload, @Query('channelId') channelId?: string) {
    return this.customerService.getStats(user.orgId!, channelId);
  }

  @Get(':id')
  @RequireSection('customers', 'orders')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customerService.findOne(id, user.orgId!);
  }

  // GSTIN and billing state decide B2B treatment and CGST/SGST vs IGST on every
  // later invoice for this customer, so they are held to the same tier as
  // editing tax setup. Tags, notes and VIP level are day-to-day work.
  @Patch(':id')
  @Roles(...ORG_OPERATORS)
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateCustomerDto) {
    const touchesGst =
      dto.gstin !== undefined ||
      dto.billingStateCode !== undefined ||
      dto.billingStateName !== undefined;
    if (touchesGst && !(user.role && ORG_MANAGERS.includes(user.role))) {
      throw new ForbiddenException(
        "Only an owner, admin or manager can change a customer's GSTIN or billing state.",
      );
    }
    return this.customerService.update(id, user.orgId!, user.sub, dto);
  }
}