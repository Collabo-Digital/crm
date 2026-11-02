import { apiClient } from "~/lib/api-client";
import type {
  PackConfirmReason,
  PackHoldReason,
  PackingAccuracyResponse,
  PackingQueueParams,
  PackingQueueResponse,
  PackProblemReason,
  PackScanResponse,
  PackTask,
} from "~/types/api";

/**
 * Orders → Packing. Every write that a retry could repeat carries a
 * `clientScanId`; the server answers a repeat with the first result.
 */
export const packingService = {
  queue: (params: PackingQueueParams) =>
    apiClient.get<PackingQueueResponse>("/packing/queue", { params }).then((r) => r.data),

  /** A packing-slip barcode (the order id) or an exact order name. */
  lookup: (code: string) =>
    apiClient.get<{ orderId: string }>("/packing/lookup", { params: { code } }).then((r) => r.data),

  /** The order's open task, or a new one. Idempotent. */
  start: (orderId: string) =>
    apiClient.post<PackTask>(`/packing/orders/${orderId}/start`).then((r) => r.data),

  task: (taskId: string) => apiClient.get<PackTask>(`/packing/tasks/${taskId}`).then((r) => r.data),

  scan: (taskId: string, data: { code: string; clientScanId: string }) =>
    apiClient.post<PackScanResponse>(`/packing/tasks/${taskId}/scan`, data).then((r) => r.data),

  confirm: (taskId: string, lineId: string, data: { qty: number; clientScanId: string; reason?: PackConfirmReason }) =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/lines/${lineId}/confirm`, data).then((r) => r.data),

  count: (taskId: string, lineId: string, data: { packed: number; clientScanId: string }) =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/lines/${lineId}/count`, data).then((r) => r.data),

  undo: (taskId: string, lineId: string, data: { clientScanId: string }) =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/lines/${lineId}/undo`, data).then((r) => r.data),

  reportProblem: (taskId: string, lineId: string, data: { reason: PackProblemReason; qty: number }) =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/lines/${lineId}/problem`, data).then((r) => r.data),

  clearProblem: (taskId: string, lineId: string) =>
    apiClient.delete<PackTask>(`/packing/tasks/${taskId}/lines/${lineId}/problem`).then((r) => r.data),

  hold: (taskId: string, data: { reason: PackHoldReason; note?: string }) =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/hold`, data).then((r) => r.data),

  resume: (taskId: string) => apiClient.post<PackTask>(`/packing/tasks/${taskId}/resume`).then((r) => r.data),

  finish: (taskId: string, mode: "all" | "partial") =>
    apiClient.post<PackTask>(`/packing/tasks/${taskId}/finish`, { mode }).then((r) => r.data),

  /** "Start over": the task is cancelled. */
  cancel: (taskId: string) => apiClient.delete<PackTask>(`/packing/tasks/${taskId}`).then((r) => r.data),

  accuracy: (params: { from?: string; to?: string; warehouseId?: string }) =>
    apiClient.get<PackingAccuracyResponse>("/packing/accuracy", { params }).then((r) => r.data),
};
