import { apiClient } from "~/lib/api-client";
import type {
  PosActivityParams,
  PosActivityResponse,
  PosReportParams,
  PosReportSummary,
} from "~/types/api";

/** Store reports — owners, admins and managers only on the server. */
export const posReportsService = {
  getSummary: (params: PosReportParams) =>
    apiClient
      .get<PosReportSummary>("/pos/reports/summary", { params })
      .then((response) => response.data),

  getActivity: (params: PosActivityParams) =>
    apiClient
      .get<PosActivityResponse>("/pos/reports/activity", { params })
      .then((response) => response.data),
};
