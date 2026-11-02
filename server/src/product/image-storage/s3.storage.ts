import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import {
  IImageStorage,
  UploadInput,
  UploadedImageMeta,
} from './image-storage.interface';

/**
 * S3-backed image storage stub. Wire this up when moving to ephemeral hosting
 * (Vercel/Lambda) or when image scale outgrows local disk. Activate via
 * `UPLOAD_STORAGE=s3` and provide `AWS_S3_BUCKET`, `AWS_REGION`, credentials.
 *
 * To finish the implementation:
 *   1. `pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
 *   2. Construct `S3Client` from env in the constructor
 *   3. Implement `upload()` via `PutObjectCommand` + return CDN URL
 *   4. Implement `delete()` via `DeleteObjectCommand`
 *   5. Implement `read()` via `GetObjectCommand`
 */
@Injectable()
export class S3ImageStorage implements IImageStorage {
  private readonly logger = new Logger(S3ImageStorage.name);

  async upload(_input: UploadInput): Promise<UploadedImageMeta> {
    throw new NotImplementedException(
      'S3 image storage is not configured. Set UPLOAD_STORAGE=local or wire up S3.',
    );
  }

  async delete(_storageKey: string): Promise<void> {
    this.logger.warn('S3 delete not implemented — orphaned object will remain.');
  }

  read(storageKey: string): Promise<Buffer> {
    return Promise.reject(
      new NotImplementedException(
        `S3 image storage is not configured, so ${storageKey} cannot be read. ` +
          'Set UPLOAD_STORAGE=local or wire up S3.',
      ),
    );
  }
}
