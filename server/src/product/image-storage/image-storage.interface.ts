// Storage abstraction for product image binaries. Default impl is local disk
// (`local.storage.ts`); production deployments on ephemeral hosts should swap
// in `s3.storage.ts` via `UPLOAD_STORAGE=s3`.

export interface UploadedImageMeta {
  /** Absolute, publicly-fetchable URL (Shopify pulls from this on push). */
  url: string;
  /** Optional MIME hint, useful for downstream consumers. */
  mimeType: string;
  /** File size in bytes — used by limits but not currently persisted. */
  size: number;
  /** Storage-specific identifier (path, S3 key) so we can delete later. */
  storageKey: string;
}

export interface UploadInput {
  orgId: string;
  /** Multer file payload from `FileInterceptor`. */
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface IImageStorage {
  upload(input: UploadInput): Promise<UploadedImageMeta>;
  delete(storageKey: string): Promise<void>;
  /**
   * The bytes of a stored file, for PDFs that embed it. Takes a storage key,
   * never a URL: documents print only files that were uploaded here.
   */
  read(storageKey: string): Promise<Buffer>;
}

export const IMAGE_STORAGE = Symbol('IMAGE_STORAGE');
