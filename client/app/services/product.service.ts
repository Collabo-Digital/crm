import { apiClient } from "~/lib/api-client";
import type {
  BulkResult,
  PaginatedResponse,
  Product,
  ProductDetail,
  ProductImage,
  ProductImportJob,
  ProductListParams,
  ProductOption,
  ProductStatsResponse,
  ProductStatus,
  ProductVariant,
  CreateProductRequest,
  CreateVariantRequest,
  UpdateProductRequest,
  UpdateVariantRequest,
  ManualSyncResponse,
} from "~/types/api";

/**
 * Service layer for product API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const productService = {
  // ── List & detail ──────────────────────────────────────────────────────
  list: (params?: ProductListParams) =>
    apiClient.get<PaginatedResponse<Product>>("/products", { params }).then((r) => r.data),

  get: (id: string) =>
    apiClient.get<ProductDetail>(`/products/${id}`).then((r) => r.data),

  vendors: () =>
    apiClient.get<string[]>("/products/vendors").then((r) => r.data),

  types: () =>
    apiClient.get<string[]>("/products/types").then((r) => r.data),

  stats: (params?: { channelId?: string }) =>
    apiClient.get<ProductStatsResponse>("/products/stats", { params }).then((r) => r.data),

  // ── Product CRUD ────────────────────────────────────────────────────────
  create: (data: CreateProductRequest) =>
    apiClient.post<ProductDetail>("/products", data).then((r) => r.data),

  update: (id: string, data: UpdateProductRequest) =>
    apiClient.patch<ProductDetail>(`/products/${id}`, data).then((r) => r.data),

  softDelete: (id: string) =>
    apiClient.delete<{ id: string; deletedAt: string }>(`/products/${id}`).then((r) => r.data),

  syncToShopify: (id: string) =>
    apiClient.post<ManualSyncResponse>(`/products/${id}/sync`).then((r) => r.data),

  // ── Variants ───────────────────────────────────────────────────────────
  createVariant: (productId: string, data: CreateVariantRequest) =>
    apiClient.post<ProductVariant>(`/products/${productId}/variants`, data).then((r) => r.data),

  updateVariant: (variantId: string, data: UpdateVariantRequest) =>
    apiClient.patch<ProductVariant>(`/products/variants/${variantId}`, data).then((r) => r.data),

  deleteVariant: (variantId: string) =>
    apiClient.delete<{ id: string; deleted: true }>(`/products/variants/${variantId}`).then((r) => r.data),

  reorderVariants: (productId: string, variantIds: string[]) =>
    apiClient.post<{ ok: true }>(`/products/${productId}/variants/reorder`, { variantIds }).then((r) => r.data),

  generateVariants: (productId: string) =>
    apiClient.post<{ ok: true; created: number }>(`/products/${productId}/variants/generate`).then((r) => r.data),

  setVariantImage: (variantId: string, imageId: string | null) =>
    apiClient.post<{ ok: true; imageId: string | null }>(`/products/variants/${variantId}/image`, { imageId }).then((r) => r.data),

  // ── Options ────────────────────────────────────────────────────────────
  updateOptions: (productId: string, options: ProductOption[]) =>
    apiClient.patch<{ ok: true; options: ProductOption[] }>(`/products/${productId}/options`, { options }).then((r) => r.data),

  // ── Images ─────────────────────────────────────────────────────────────
  uploadImage: (productId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiClient
      .post<ProductImage>(`/products/${productId}/images`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  updateImage: (imageId: string, alt: string | null) =>
    apiClient.patch<ProductImage>(`/products/images/${imageId}`, { alt }).then((r) => r.data),

  removeImage: (imageId: string) =>
    apiClient.delete<{ id: string; deleted: true }>(`/products/images/${imageId}`).then((r) => r.data),

  reorderImages: (productId: string, imageIds: string[]) =>
    apiClient.post<{ ok: true }>(`/products/${productId}/images/reorder`, { imageIds }).then((r) => r.data),

  // ── Bulk operations ────────────────────────────────────────────────────
  bulkSetStatus: (productIds: string[], status: ProductStatus) =>
    apiClient
      .post<BulkResult>("/products/bulk/status", { productIds, status })
      .then((r) => r.data),

  bulkArchive: (productIds: string[]) =>
    apiClient
      .post<BulkResult>("/products/bulk/archive", { productIds })
      .then((r) => r.data),

  bulkDelete: (productIds: string[]) =>
    apiClient
      .delete<BulkResult>("/products/bulk", { data: { productIds } })
      .then((r) => r.data),

  bulkAddTags: (productIds: string[], tags: string[]) =>
    apiClient
      .post<BulkResult>("/products/bulk/tags/add", { productIds, tags })
      .then((r) => r.data),

  bulkRemoveTags: (productIds: string[], tags: string[]) =>
    apiClient
      .post<BulkResult>("/products/bulk/tags/remove", { productIds, tags })
      .then((r) => r.data),

  bulkSync: (productIds: string[]) =>
    apiClient
      .post<BulkResult>("/products/bulk/sync", { productIds })
      .then((r) => r.data),

  // ── Duplicate ──────────────────────────────────────────────────────────
  duplicate: (productId: string) =>
    apiClient.post<ProductDetail>(`/products/${productId}/duplicate`).then((r) => r.data),

  // ── CSV import + export ────────────────────────────────────────────────

  /**
   * Fetch the export as a blob through the authenticated apiClient, then
   * trigger a browser download. We can't use a plain `<a download>` because
   * the API requires a Bearer token that isn't in cookies.
   */
  downloadExportCsv: async (params?: {
    status?: string;
    vendor?: string;
    productType?: string;
    search?: string;
  }): Promise<void> => {
    const response = await apiClient.get("/products/export.csv", {
      params,
      responseType: "blob",
      // Override the response interceptor's envelope unwrap (CSV is raw text).
      transformResponse: [(d) => d],
    });
    const blob = new Blob([response.data], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  startImport: (file: File): Promise<ProductImportJob> => {
    const fd = new FormData();
    fd.append("file", file);
    return apiClient
      .post<ProductImportJob>("/products/import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  confirmImport: (jobId: string, file: File): Promise<ProductImportJob> => {
    const fd = new FormData();
    fd.append("file", file);
    return apiClient
      .post<ProductImportJob>(`/products/import/${jobId}/confirm`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  getImportJob: (jobId: string) =>
    apiClient.get<ProductImportJob>(`/products/import/${jobId}`).then((r) => r.data),
};
