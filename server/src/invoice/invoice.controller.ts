import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { InvoiceService } from './invoice.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { BulkCreateInvoicesDto } from './dto/bulk-create-invoices.dto';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import { QueryGstReturnDto } from './dto/query-gst-return.dto';
import { QueryInvoiceStatsDto } from './dto/query-invoice-stats.dto';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { MarkFiledDto } from './dto/mark-filed.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { Throttle } from '@nestjs/throttler';
import { attachmentDisposition } from '../common/utils/content-disposition.util';
import { neutraliseCsvFormula } from '../common/utils/csv-formula.util';
import { renderCsvSections } from './gst-return-rows';

@RequireSection('invoices')
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  // POST /api/v1/invoices — generate a GST invoice for an order
  @Post()
  @Roles(...ORG_MANAGERS)
  create(@OrgId() orgId: string, @Body() dto: CreateInvoiceDto) {
    return this.invoiceService.create(orgId, dto);
  }

  // POST /api/v1/invoices/bulk — generate GST invoices for selected orders.
  // Static route, so it is declared before the :id POST routes below. Each
  // call runs up to MAX_BULK_INVOICES Serializable transactions, so it gets a
  // tighter limit than the global 60/min.
  @Post('bulk')
  @Roles(...ORG_MANAGERS)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  bulkCreate(@OrgId() orgId: string, @Body() dto: BulkCreateInvoicesDto) {
    return this.invoiceService.bulkCreate(orgId, dto.orderIds);
  }

  // GET /api/v1/invoices/stats — KPI aggregates and filter-chip counts
  // IMPORTANT: static routes BEFORE :id param route
  @Get('stats')
  getStats(@OrgId() orgId: string, @Query() query: QueryInvoiceStatsDto) {
    return this.invoiceService.getStats(orgId, query);
  }

  // GET /api/v1/invoices/gst-return — GSTR-1 or GSTR-3B summary
  // IMPORTANT: static routes BEFORE :id param route
  @Get('gst-return')
  getGstReturn(
    @OrgId() orgId: string,
    @Query() query: QueryGstReturnDto,
  ) {
    return this.invoiceService.getGstReturn(orgId, query);
  }

  // GET /api/v1/invoices/gst-return/export/csv — download GST return as CSV
  @Get('gst-return/export/csv')
  async exportGstReturnCsv(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryGstReturnDto,
    @Res() res: Response,
  ) {
    // Sectioned, not one flat table.
    //
    // Every statutory table used to share a single 12-column row shape, which
    // forced the HSN summary to put its code in the `invoiceNumber` column and
    // a quantity string in `grandTotal`. Beyond being unreadable, it left no
    // free column — Table 12 needs a UQC and a rate, and neither could be added
    // without changing the column count of every other section. Each table now
    // carries its own header block and exactly the columns the statute asks for.
    //
    // json2csv is not used here: it emits one header for one row shape, which
    // is the constraint being removed.
    const sections = await this.invoiceService.getGstReturnExportData(
      orgId,
      query,
      user,
    );
    const csv = renderCsvSections(sections);

    const filename = `${query.returnType || 'GSTR1'}-${query.financialYear}-${query.period}.csv`;
    // charset matters: buyer and state names are free text and routinely
    // non-ASCII. Without it Excel decodes UTF-8 as cp1252 and mojibakes every
    // such name. product.controller.ts already sets it — this was the outlier.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachmentDisposition(filename, 'gst-return.csv'));
    res.send(csv);
  }

  // GET /api/v1/invoices/export/csv — export invoices as CSV
  @Get('export/csv')
  async exportCsv(
    @OrgId() orgId: string,
    @Query() query: QueryInvoicesDto,
    @Res() res: Response,
  ) {
    const data = await this.invoiceService.getExportData(orgId, query);

    // Use json2csv pattern from order controller
    const { Parser } = await import('json2csv');
    const parser = new Parser({
      fields: [
        'invoiceNumber',
        'invoiceDate',
        'financialYear',
        'orderNumber',
        'buyerName',
        'buyerGstin',
        'placeOfSupply',
        'gstType',
        'subtotal',
        'discount',
        'cgst',
        'sgst',
        'igst',
        'totalTax',
        // subtotal + totalTax + shipping = grandTotal. Without the shipping
        // column the row does not reconcile and reads as an arithmetic error.
        'shipping',
        'grandTotal',
        'status',
        // Last on purpose: appending keeps every existing column position
        // stable for anyone with a saved import mapping.
        'dispatchFrom',
      ],
    });
    // Buyer names are typed by shoppers; keep them from running as formulas.
    const csv = parser.parse(
      data.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === 'string' ? neutraliseCsvFormula(value) : value,
          ]),
        ),
      ),
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      attachmentDisposition(
        `invoices${query.financialYear ? `-${query.financialYear}` : ''}.csv`,
        'invoices.csv',
      ),
    );
    res.send(csv);
  }

  // GET /api/v1/invoices/export/json — export invoices as JSON
  @Get('export/json')
  async exportJson(
    @OrgId() orgId: string,
    @Query() query: QueryInvoicesDto,
  ) {
    return this.invoiceService.getExportData(orgId, query);
  }

  // GET /api/v1/invoices/refunds-pending-credit — refunded orders not yet credited
  // IMPORTANT: static routes BEFORE :id param route
  @Get('refunds-pending-credit')
  listRefundsNeedingCreditNote(@OrgId() orgId: string) {
    return this.invoiceService.listRefundsNeedingCreditNote(orgId);
  }

  // GET /api/v1/invoices — list invoices (paginated)
  @Get()
  findAll(@OrgId() orgId: string, @Query() query: QueryInvoicesDto) {
    return this.invoiceService.findAll(orgId, query);
  }

  // GET /api/v1/invoices/:id/pdf — the invoice as a PDF file
  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @OrgId() orgId: string, @Res() res: Response) {
    const { buffer, filename } = await this.invoiceService.pdf(id, orgId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', attachmentDisposition(filename, 'invoice.pdf'));
    res.send(buffer);
  }

  // GET /api/v1/invoices/:id — get full invoice detail
  @Get(':id')
  findOne(@Param('id') id: string, @OrgId() orgId: string) {
    return this.invoiceService.findOne(id, orgId);
  }

  // GET /api/v1/invoices/filings — which periods are locked
  // IMPORTANT: static routes BEFORE :id param route
  @Get('gst-return/filings')
  listFilings(
    @OrgId() orgId: string,
    @Query('financialYear') financialYear?: string,
  ) {
    return this.invoiceService.listFilings(orgId, financialYear);
  }

  // POST /api/v1/invoices/gst-return/filings — mark a period filed, locking it
  //
  // Role-gated: locking a period stops anyone issuing or cancelling an invoice
  // inside it, which is squarely a statutory action.
  @Post('gst-return/filings')
  @Roles(...ORG_MANAGERS)
  markFiled(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: MarkFiledDto,
  ) {
    return this.invoiceService.markFiled(orgId, dto, user.sub);
  }

  // DELETE /api/v1/invoices/gst-return/filings/:id — reopen a period filed in error
  //
  // A lock with no key turns a mistaken click into a permanently unusable month.
  @Delete('gst-return/filings/:id')
  @Roles(...ORG_MANAGERS)
  unfile(@OrgId() orgId: string, @Param('id') id: string) {
    return this.invoiceService.unfile(orgId, id);
  }

  // POST /api/v1/invoices/:id/credit-note — reverse an issued invoice
  //
  // The statutory correction for a filed period. Unlike cancelling, it is
  // additive and leaves a trail: the original invoice stays in the return and
  // the credit note nets against it.
  @Post(':id/credit-note')
  @Roles(...ORG_MANAGERS)
  createCreditNote(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: CreateCreditNoteDto,
  ) {
    return this.invoiceService.createCreditNote(orgId, id, dto);
  }

  // POST /api/v1/invoices/:id/cancel — cancel an issued invoice
  @Post(':id/cancel')
  @Roles(...ORG_MANAGERS)
  cancel(@Param('id') id: string, @OrgId() orgId: string) {
    return this.invoiceService.cancel(id, orgId);
  }

  // PATCH /api/v1/invoices/:id — correct the non-tax fields of an issued invoice
  @Patch(':id')
  @Roles(...ORG_MANAGERS)
  update(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoiceService.update(id, orgId, dto, user.sub);
  }
}
