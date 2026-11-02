import { Module } from '@nestjs/common';
import { GstModule } from '../gst/gst.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { ImageStorageModule } from '../product/image-storage/image-storage.module';
import { InvoiceController } from './invoice.controller';
import { InvoiceDesignController } from './invoice-design.controller';
import { InvoiceService } from './invoice.service';
import { InvoiceNumberService } from './invoice-number.service';

// WHY import GstModule?
// InvoiceService needs GstService for seller GSTIN lookup
// and GstCalculatorService for tax calculations.
// ImageStorageModule: the uploaded logo and signature a PDF embeds.
@Module({
  imports: [GstModule, CommerceEventsModule, ImageStorageModule],
  controllers: [InvoiceController, InvoiceDesignController],
  providers: [InvoiceService, InvoiceNumberService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
