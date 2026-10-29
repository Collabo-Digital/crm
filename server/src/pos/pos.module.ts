import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { ChannelModule } from '../channel/channel.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ImageStorageModule } from '../product/image-storage/image-storage.module';
import { PosController } from './pos.controller';
import { PosPublicController } from './pos-public.controller';
import { PosCatalogService } from './pos-catalog.service';
import { PosStaffService } from './pos-staff.service';
import { PosSaleService } from './pos-sale.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosWhatsAppService } from './pos-whatsapp.service';
import { PosBillService } from './pos-bill.service';

// WHY these imports?
//   OrderModule      — every bill is made by OrderService.createOfflineOrder.
//   InventoryModule  — whether stock is per warehouse (a store) or one number.
//   MessagingModule  — WhatsApp consent and sending the bill.
//   ChannelModule    — marking a bill paid on Shopify when its balance is collected.
//   InvoiceModule, CommerceEventsModule — the follow-ups of a bill becoming paid.
//   LoyaltyModule    — a walk-in bill's customer, added to send it, gets its order counted.
//   ImageStorageModule — the uploaded logo on a bill's PDF.
@Module({
    imports: [
        OrderModule,
        OrganizationSettingsModule,
        InventoryModule,
        MessagingModule,
        CommerceEventsModule,
        ChannelModule,
        InvoiceModule,
        LoyaltyModule,
        ImageStorageModule,
    ],
    controllers: [PosController, PosPublicController],
    providers: [PosCatalogService, PosStaffService, PosSaleService, PosReceiptService, PosWhatsAppService, PosBillService],
})
export class PosModule { }
