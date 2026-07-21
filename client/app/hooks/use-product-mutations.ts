import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { productService } from "~/services/product.service";
import { productKeys } from "~/hooks/use-product-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type {
  BulkResult,
  CreateProductRequest,
  CreateVariantRequest,
  ProductOption,
  ProductStatus,
  UpdateProductRequest,
  UpdateVariantRequest,
} from "~/types/api";

/** Create a CRM-native product. */
export function useCreateProductMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateProductRequest) => productService.create(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });

      const queued = (result as { shopifyPushQueued?: boolean }).shopifyPushQueued;
      if (queued) {
        toast.success("Product created. Syncing to Shopify…");
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: productKeys.all });
        }, 3000);
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: productKeys.all });
        }, 8000);
      } else {
        toast.success(
          "Product created. Sync to Shopify manually when you're ready.",
        );
      }
    },
    onError: (error) =>
      handleMutationError(error, "Failed to create product."),
  });
}

/** Edit a MANUAL-channel product. */
export function useUpdateProductMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProductRequest }) =>
      productService.update(id, data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.detail(vars.id) });
      toast.success("Product updated.");
    },
    onError: (error) =>
      handleMutationError(error, "Failed to update product."),
  });
}

/** Soft-delete (archive) a MANUAL-channel product. */
export function useDeleteProductMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => productService.softDelete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success("Product archived.");
    },
    onError: (error) =>
      handleMutationError(error, "Failed to archive product."),
  });
}

/**
 * POST /products/:id/sync — manually push a MANUAL product to Shopify.
 * Idempotent; the toast reflects the server's status.
 */
export function useSyncProductMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => productService.syncToShopify(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      if (result.status === "ALREADY_SYNCED") {
        toast.info("Product already synced to Shopify.");
      } else if (result.status === "ALREADY_QUEUED") {
        toast.info("Sync already in progress.");
      } else {
        toast.success("Sync to Shopify queued.");
      }
    },
    onError: (error) => handleMutationError(error, "Failed to sync product."),
  });
}

// ─── VARIANT MUTATIONS ──────────────────────────────────────────────────────

/** Add a new variant to an existing product. */
export function useCreateVariantMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateVariantRequest) =>
      productService.createVariant(productId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success("Variant added.");
    },
    onError: (error) => handleMutationError(error, "Failed to add variant."),
  });
}

/** Edit a single variant. */
export function useUpdateVariantMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variantId, data }: { variantId: string; data: UpdateVariantRequest }) =>
      productService.updateVariant(variantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success("Variant updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update variant."),
  });
}

/** Delete a single variant (forbidden if it's the last one). */
export function useDeleteVariantMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variantId: string) => productService.deleteVariant(variantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success("Variant deleted.");
    },
    onError: (error) => handleMutationError(error, "Failed to delete variant."),
  });
}

/** Reorder variants by sending the new ordered list of IDs. */
export function useReorderVariantsMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variantIds: string[]) =>
      productService.reorderVariants(productId, variantIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
    onError: (error) => handleMutationError(error, "Failed to reorder variants."),
  });
}

/** Generate variants from defined options (cartesian product, skip existing). */
export function useGenerateVariantsMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => productService.generateVariants(productId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success(`Generated ${result.created} new variant${result.created === 1 ? "" : "s"}.`);
    },
    onError: (error) => handleMutationError(error, "Failed to generate variants."),
  });
}

/** Bind a variant to a product image (or unset by passing null). */
export function useSetVariantImageMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variantId, imageId }: { variantId: string; imageId: string | null }) =>
      productService.setVariantImage(variantId, imageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
    onError: (error) => handleMutationError(error, "Failed to set variant image."),
  });
}

// ─── OPTIONS MUTATIONS ──────────────────────────────────────────────────────

/** Replace the product's option types definition. */
export function useUpdateOptionsMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: ProductOption[]) =>
      productService.updateOptions(productId, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
    onError: (error) => handleMutationError(error, "Failed to update options."),
  });
}

// ─── IMAGE MUTATIONS ────────────────────────────────────────────────────────

/** Upload a single image file via multipart. */
export function useUploadImageMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => productService.uploadImage(productId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
    },
    onError: (error) => handleMutationError(error, "Failed to upload image."),
  });
}

/** Edit an image's alt text. */
export function useUpdateImageMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ imageId, alt }: { imageId: string; alt: string | null }) =>
      productService.updateImage(imageId, alt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
    onError: (error) => handleMutationError(error, "Failed to update image."),
  });
}

/** Delete an image (storage cleanup is best-effort on the server). */
export function useRemoveImageMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) => productService.removeImage(imageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success("Image removed.");
    },
    onError: (error) => handleMutationError(error, "Failed to remove image."),
  });
}

/** Reorder images by sending the new ordered list of IDs. */
export function useReorderImagesMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageIds: string[]) =>
      productService.reorderImages(productId, imageIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
    onError: (error) => handleMutationError(error, "Failed to reorder images."),
  });
}

// ─── PHASE 3: BULK MUTATIONS ────────────────────────────────────────────────
// All bulk hooks share the same toast pattern: report `ok.length` succeeded
// and `skipped.length` skipped (with the first reason for context). The
// invalidation always covers the whole product cache because bulk affects
// many rows at once.

function toastBulkResult(result: BulkResult, verb: string) {
  const okCount = result.ok.length;
  const skipCount = result.skipped.length;
  if (okCount === 0 && skipCount > 0) {
    toast.warning(
      `${skipCount} product${skipCount === 1 ? "" : "s"} skipped: ${result.skipped[0].reason}`,
    );
  } else if (skipCount > 0) {
    toast.success(
      `${okCount} ${verb}, ${skipCount} skipped (${result.skipped[0].reason}).`,
    );
  } else {
    toast.success(`${okCount} product${okCount === 1 ? "" : "s"} ${verb}.`);
  }
}

export function useBulkSetStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productIds, status }: { productIds: string[]; status: ProductStatus }) =>
      productService.bulkSetStatus(productIds, status),
    onSuccess: (result, vars) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toastBulkResult(result, `set to ${vars.status.toLowerCase()}`);
    },
    onError: (error) => handleMutationError(error, "Failed to update products."),
  });
}

export function useBulkArchiveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productIds: string[]) => productService.bulkArchive(productIds),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toastBulkResult(result, "archived");
    },
    onError: (error) => handleMutationError(error, "Failed to archive products."),
  });
}

export function useBulkDeleteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productIds: string[]) => productService.bulkDelete(productIds),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toastBulkResult(result, "permanently deleted");
    },
    onError: (error) => handleMutationError(error, "Failed to delete products."),
  });
}

export function useBulkAddTagsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productIds, tags }: { productIds: string[]; tags: string[] }) =>
      productService.bulkAddTags(productIds, tags),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toastBulkResult(result, "tagged");
    },
    onError: (error) => handleMutationError(error, "Failed to tag products."),
  });
}

export function useBulkRemoveTagsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productIds, tags }: { productIds: string[]; tags: string[] }) =>
      productService.bulkRemoveTags(productIds, tags),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toastBulkResult(result, "untagged");
    },
    onError: (error) => handleMutationError(error, "Failed to untag products."),
  });
}

export function useBulkSyncMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productIds: string[]) => productService.bulkSync(productIds),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      const queued = result.queued ?? 0;
      const skipCount = result.skipped.length;
      if (queued === 0 && skipCount > 0) {
        toast.warning(`Could not queue any sync jobs: ${result.skipped[0].reason}`);
      } else if (skipCount > 0) {
        toast.success(`Queued ${queued} sync job${queued === 1 ? "" : "s"}, ${skipCount} skipped.`);
      } else {
        toast.success(`Queued ${queued} product${queued === 1 ? "" : "s"} for Shopify sync.`);
      }
    },
    onError: (error) => handleMutationError(error, "Failed to queue sync jobs."),
  });
}

// ─── PHASE 3: DUPLICATE ─────────────────────────────────────────────────────

export function useDuplicateProductMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => productService.duplicate(productId),
    onSuccess: (newProduct) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success(`Duplicated as "${newProduct.title}".`);
    },
    onError: (error) => handleMutationError(error, "Failed to duplicate product."),
  });
}

// ─── PHASE 3: CSV IMPORT ────────────────────────────────────────────────────

/** Stage 1 — upload, parse, get a preview. */
export function useStartImportMutation() {
  return useMutation({
    mutationFn: (file: File) => productService.startImport(file),
    onError: (error) => handleMutationError(error, "Failed to read CSV."),
  });
}

/** Stage 2 — re-upload to confirm and run the import. */
export function useConfirmImportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, file }: { jobId: string; file: File }) =>
      productService.confirmImport(jobId, file),
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      if (job.status === "COMPLETED") {
        toast.success(
          `Import complete: ${job.createdCount} created${job.errorCount > 0 ? `, ${job.errorCount} errors` : ""}.`,
        );
      } else {
        toast.error(`Import failed (${job.errorCount} error${job.errorCount === 1 ? "" : "s"}).`);
      }
    },
    onError: (error) => handleMutationError(error, "Failed to run import."),
  });
}
