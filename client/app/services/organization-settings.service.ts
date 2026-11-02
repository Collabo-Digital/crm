import { apiClient } from "~/lib/api-client";
import type {
  OrganizationSettingsResponse,
  ProductSettings,
  OrderSettings,
  TaxSettings,
  UpdateTaxSettingsRequest,
  InventorySettings,
  UpdateProductSettingsRequest,
  UpdateOrderSettingsRequest,
  UpdateInventorySettingsRequest,
  StoreProfileSettings,
  UpdateStoreProfileSettingsRequest,
  InvoiceSample,
  InvoiceSettings,
  UpdateInvoiceSettingsRequest,
} from "~/types/api";

/** A file as the one multipart field the upload routes read. */
function fileForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

const multipart = { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 };

/**
 * Client for per-organization settings. Three domains — `productSettings`,
 * `orderSettings` and `inventorySettings` — each mapping to a JSONB column and
 * a PATCH endpoint on the server.
 *
 * Note the inventory PATCH is role-gated server-side (`@Roles(...ORG_MANAGERS)`)
 * where the other two are not; a VIEWER calling it gets a 403.
 */
export const organizationSettingsService = {
  get: () =>
    apiClient
      .get<OrganizationSettingsResponse>("/organization/settings")
      .then((response) => response.data),

  updateProductSettings: (data: UpdateProductSettingsRequest) =>
    apiClient
      .patch<ProductSettings>("/organization/settings/products", data)
      .then((response) => response.data),

  updateTaxSettings: (data: UpdateTaxSettingsRequest) =>
    apiClient
      .patch<TaxSettings>("/organization/settings/tax", data)
      .then((res) => res.data),

  updateOrderSettings: (data: UpdateOrderSettingsRequest) =>
    apiClient
      .patch<OrderSettings>("/organization/settings/orders", data)
      .then((response) => response.data),

  updateInventorySettings: (data: UpdateInventorySettingsRequest) =>
    apiClient
      .patch<InventorySettings>("/organization/settings/inventory", data)
      .then((response) => response.data),

  updateStoreProfileSettings: (data: UpdateStoreProfileSettingsRequest) =>
    apiClient
      .patch<StoreProfileSettings>("/organization/settings/store-profile", data)
      .then((response) => response.data),

  /** PNG or JPEG up to 1 MB; the server checks the file's first bytes. */
  uploadLogo: (file: File) =>
    apiClient
      .post<StoreProfileSettings>("/organization/settings/store-profile/logo", fileForm(file), multipart)
      .then((response) => response.data),

  /** Clears the logo; the file stays, because issued invoices may print it. */
  removeLogo: () =>
    apiClient
      .delete<StoreProfileSettings>("/organization/settings/store-profile/logo")
      .then((response) => response.data),

  updateInvoiceSettings: (data: UpdateInvoiceSettingsRequest) =>
    apiClient
      .patch<InvoiceSettings>("/organization/settings/invoice", data)
      .then((response) => response.data),

  /** PNG or JPEG up to 300 KB. */
  uploadSignature: (file: File) =>
    apiClient
      .post<InvoiceSettings>("/organization/settings/invoice/signature", fileForm(file), multipart)
      .then((response) => response.data),

  removeSignature: () =>
    apiClient
      .delete<InvoiceSettings>("/organization/settings/invoice/signature")
      .then((response) => response.data),

  /**
   * A sample document as a PDF, drawn with `settings` over the saved ones
   * without saving them. The bytes come back raw, like an invoice's PDF.
   */
  previewInvoice: (body: { sample: InvoiceSample; settings: UpdateInvoiceSettingsRequest }, signal?: AbortSignal) =>
    apiClient
      .post<ArrayBuffer>("/organization/settings/invoice/preview", body, { responseType: "arraybuffer", signal })
      .then((response) => response.data),
};
