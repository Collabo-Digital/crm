import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { posReportsService } from "~/services/pos-reports.service";
import type { PosActivityParams, PosReportParams } from "~/types/api";

export const posReportKeys = {
  all: ["pos-reports"] as const,
  summary: (params: PosReportParams) => [...posReportKeys.all, "summary", params] as const,
  activity: (params: PosActivityParams) => [...posReportKeys.all, "activity", params] as const,
};

/**
 * Sales, bills, stores, staff, payment methods and top products for a period.
 * A new period or store keeps the last one on screen, dimmed, until it lands.
 */
export function usePosSummary(params: PosReportParams) {
  return useQuery({
    queryKey: posReportKeys.summary(params),
    queryFn: () => posReportsService.getSummary(params),
    placeholderData: keepPreviousData,
  });
}

/** The counter log: sales, approvals, wrong PINs and unlocks, newest first. */
export function usePosActivity(params: PosActivityParams, enabled = true) {
  return useQuery({
    queryKey: posReportKeys.activity(params),
    queryFn: () => posReportsService.getActivity(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}
