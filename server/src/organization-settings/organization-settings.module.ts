import { Module } from '@nestjs/common';
import { OrganizationSettingsService } from './organization-settings.service';
import { OrganizationSettingsController } from './organization-settings.controller';
import { ImageStorageModule } from '../product/image-storage/image-storage.module';

// ImageStorageModule, not ProductModule: ProductModule imports this module,
// and the logo and signature uploads need only the store.
@Module({
  imports: [ImageStorageModule],
  controllers: [OrganizationSettingsController],
  providers: [OrganizationSettingsService],
  exports: [OrganizationSettingsService],
})
export class OrganizationSettingsModule {}
