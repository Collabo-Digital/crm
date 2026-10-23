import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { OrderModule } from '../order/order.module';
import { DraftOrderModule } from '../draft-order/draft-order.module';
import { CatalogService } from './catalog.service';
import { CommerceController } from './commerce.controller';
import { StoreActionsService } from './store-actions.service';

/**
 * Selling in chat: the WhatsApp catalog, product messages, and the store
 * actions automations and the inbox take on orders and carts.
 */
@Module({
    imports: [ChannelModule, MessagingModule, OrderModule, DraftOrderModule],
    controllers: [CommerceController],
    providers: [CatalogService, StoreActionsService],
    exports: [CatalogService, StoreActionsService],
})
export class CommerceModule { }
