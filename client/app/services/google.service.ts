import { apiClient } from "~/lib/api-client";
import type { GoogleIntegration, SheetColumn } from "~/types/api";

/** Google Sheets for automations: the organization's Google account and the sheets in use. */
export const googleService = {
  status: () => apiClient.get<GoogleIntegration>("/integrations/google").then((r) => r.data),
  connectUrl: () => apiClient.get<{ url: string }>("/integrations/google/connect").then((r) => r.data),
  /** The code Google sent the browser back with, finished by the person who started. */
  complete: (code: string, state: string) => apiClient.post<GoogleIntegration>("/integrations/google/complete", { code, state }).then((r) => r.data),
  disconnect: () => apiClient.delete("/integrations/google"),
  pickerToken: () => apiClient.get<{ accessToken: string }>("/integrations/google/picker-token").then((r) => r.data),
  createSheet: (body: { title: string; headers: string[] }) => apiClient.post<GoogleIntegration>("/integrations/google/sheets", body).then((r) => r.data),
  addPicked: (spreadsheetId: string) => apiClient.post<GoogleIntegration>("/integrations/google/sheets/picked", { spreadsheetId }).then((r) => r.data),
  removeSheet: (id: string) => apiClient.delete<GoogleIntegration>(`/integrations/google/sheets/${id}`).then((r) => r.data),
  columns: (id: string) => apiClient.get<{ columns: SheetColumn[] }>(`/integrations/google/sheets/${id}/columns`).then((r) => r.data.columns),
};
