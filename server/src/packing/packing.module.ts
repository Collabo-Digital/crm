import { Module } from '@nestjs/common';
import { PackingController } from './packing.controller';
import { PackingService } from './packing.service';

// Prisma only (global). Exported for the order detail's packing line; it must
// never import OrderModule, which imports it.
@Module({
    controllers: [PackingController],
    providers: [PackingService],
    exports: [PackingService],
})
export class PackingModule { }
