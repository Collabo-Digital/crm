import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommerceModule } from '../commerce/commerce.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { ChannelModule } from '../channel/channel.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { PosController } from './pos.controller';
import { PosCatalogService } from './pos-catalog.service';
import { PosStaffService } from './pos-staff.service';
import { PosSaleService } from './pos-sale.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosWhatsAppService } from './pos-whatsapp.service';

// WHY these imports?
//   OrderModule      — every bill is made by OrderService.createOfflineOrder.
//   InventoryModule  — whether stock is per warehouse (a store) or one number.
//   MessagingModule  — WhatsApp consent and sending the invoice.
//   CommerceModule   — the invoice PDF the automations send.
//   ChannelModule    — marking a bill paid on Shopify when its balance is collected.
//   InvoiceModule, CommerceEventsModule — the follow-ups of a bill becoming paid.
@Module({
    imports: [
        OrderModule,
        OrganizationSettingsModule,
        InventoryModule,
        MessagingModule,
        CommerceModule,
        CommerceEventsModule,
        ChannelModule,
        InvoiceModule,
    ],
    controllers: [PosController],
    providers: [PosCatalogService, PosStaffService, PosSaleService, PosReceiptService, PosWhatsAppService],
})
export class PosModule { }
