import { Module } from '@nestjs/common';
import { IMAGE_STORAGE } from './image-storage.interface';
import { LocalImageStorage } from './local.storage';
import { S3ImageStorage } from './s3.storage';

/**
 * The image store on its own, so modules that ProductModule itself imports
 * (organization settings, for the logo and signature) can use it without a
 * circular import. Swap the implementation via `UPLOAD_STORAGE`.
 */
@Module({
  providers: [
    LocalImageStorage,
    S3ImageStorage,
    {
      provide: IMAGE_STORAGE,
      useFactory: (local: LocalImageStorage, s3: S3ImageStorage) =>
        process.env.UPLOAD_STORAGE === 's3' ? s3 : local,
      inject: [LocalImageStorage, S3ImageStorage],
    },
  ],
  exports: [IMAGE_STORAGE],
})
export class ImageStorageModule {}
