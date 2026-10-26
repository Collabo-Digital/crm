import axios, { type AxiosRequestConfig } from "axios";
import { apiClient, apiUrl } from "~/lib/api-client";
import { readTokenExpiry } from "~/lib/jwt";
import { useAuthStore } from "~/stores/auth.store";
import type {
  PosApprovalReason,
  PosApprovalResult,
  PosBillState,
  PosCustomer,
  PosPaymentInput,
  PosProduct,
  PosReceipt,
  PosSaleRequest,
  PosSaleResult,
  PosSettings,
  PosSetup,
  PosStaffRole,
  PosStaffView,
  PosUnlockResult,
} from "~/types/api";

/**
 * A wrong PIN answers 401, which the API client reads as an expired session:
 * it refreshes and sends the PIN again, so one wrong PIN would count twice
 * towards the lock-out. While the session has time left there is nothing to
 * refresh, so that retry is switched off (the client skips requests already
 * marked as retried).
 */
function pinRequest(): AxiosRequestConfig | undefined {
  const expiresAt = readTokenExpiry(useAuthStore.getState().accessToken);
  return expiresAt && expiresAt - Date.now() > 30_000 ? ({ _hasRetried: true } as AxiosRequestConfig) : undefined;
}

/** Orders → Point of sale: the till, its settings and staff, and receipts. */
export const posService = {
  setup: (storeId?: string) => apiClient.get<PosSetup>("/pos/setup", { params: { storeId } }).then((r) => r.data),
  updateSettings: (data: Partial<PosSettings>) => apiClient.patch<PosSettings>("/pos/settings", data).then((r) => r.data),

  staff: () => apiClient.get<PosStaffView[]>("/pos/staff").then((r) => r.data),
  createStaff: (data: { name: string; role: PosStaffRole; pin: string }) =>
    apiClient.post<PosStaffView>("/pos/staff", data).then((r) => r.data),
  updateStaff: (id: string, data: { name?: string; role?: PosStaffRole; pin?: string; isActive?: boolean }) =>
    apiClient.patch<PosStaffView>(`/pos/staff/${id}`, data).then((r) => r.data),

  unlock: (pin: string) => apiClient.post<PosUnlockResult>("/pos/unlock", { pin }, pinRequest()).then((r) => r.data),
  approve: (data: { pin: string; reason: PosApprovalReason; amount?: number }) =>
    apiClient.post<PosApprovalResult>("/pos/approve", data, pinRequest()).then((r) => r.data),

  products: (params: { search?: string; storeId?: string; limit?: number }) =>
    apiClient.get<PosProduct[]>("/pos/products", { params }).then((r) => r.data),
  scan: (code: string, storeId?: string) =>
    apiClient.get<PosProduct>("/pos/scan", { params: { code, storeId } }).then((r) => r.data),
  customers: (search: string) =>
    apiClient.get<PosCustomer[]>("/pos/customers", { params: { search } }).then((r) => r.data),

  createSale: (data: PosSaleRequest) => apiClient.post<PosSaleResult>("/pos/sales", data).then((r) => r.data),
  collectPayment: (orderId: string, data: PosPaymentInput & { staffToken?: string }) =>
    apiClient.post<PosSaleResult>(`/pos/sales/${orderId}/payments`, data).then((r) => r.data),

  delivery: (orderId: string) => apiClient.get<PosBillState>(`/pos/sales/${orderId}/delivery`).then((r) => r.data),
  /** Sends the bill again, to `phone` when given (+91…), else to the number already on the sale. */
  sendBill: (orderId: string, phone?: string) =>
    apiClient.post<PosBillState>(`/pos/sales/${orderId}/send-bill`, { channel: "whatsapp", phone }).then((r) => r.data),

  receipt: (orderId: string) => apiClient.get<PosReceipt>(`/pos/receipts/${orderId}`).then((r) => r.data),
  /**
   * The customer's bill behind a link. Plain axios rather than apiClient: the
   * page is public, so it must send no staff token, and a 401 must not start
   * a session refresh.
   */
  publicBill: (token: string) =>
    axios
      .get<{ data: PosReceipt }>(apiUrl(`/public/bills/${encodeURIComponent(token)}`), { timeout: 30_000 })
      .then((r) => r.data.data),
};
