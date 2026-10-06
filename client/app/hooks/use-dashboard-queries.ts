import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useExclusiveDownload } from "~/hooks/use-exclusive-download";
import { dashboardService } from "~/services/dashboard.service";
import type { DashboardQueryParams } from "~/types/api";

/** React Query key factory for all dashboard-related queries. */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  overview: (params?: DashboardQueryParams) =>
    [...dashboardKeys.all, "overview", params] as const,
  salesAndProfit: (params?: DashboardQueryParams) =>
    [...dashboardKeys.all, "sales-and-profit", params] as const,
  salesByCategory: (params?: DashboardQueryParams) =>
    [...dashboardKeys.all, "sales-by-category", params] as const,
};

/**
 * Fetch the dashboard overview (stats, top products, recent orders).
 *
 * The dashboard hooks keep the previous window's data on screen while a new
 * range loads (`isPlaceholderData`), so a range switch dims the page instead
 * of dropping it back to skeletons.
 */
export function useDashboard(params?: DashboardQueryParams) {
  return useQuery({
    queryKey: dashboardKeys.overview(params),
    queryFn: () => dashboardService.getOverview(params),
    placeholderData: keepPreviousData,
  });
}

/**
 * Sales and gross profit for the selected window.
 *
 * Drives the stat cards AND the bar chart. Both must pass the SAME params or
 * React Query hands them two different responses and the page goes back to
 * showing a headline figure that disagrees with the bars underneath it.
 */
export function useSalesAndProfit(params?: DashboardQueryParams) {
  return useQuery({
    queryKey: dashboardKeys.salesAndProfit(params),
    queryFn: () => dashboardService.getSalesAndProfit(params),
    placeholderData: keepPreviousData,
  });
}

/** Fetch sales breakdown by product type for the donut chart. */
export function useSalesByCategory(params?: DashboardQueryParams) {
  return useQuery({
    queryKey: dashboardKeys.salesByCategory(params),
    queryFn: () => dashboardService.getSalesByCategory(params),
    placeholderData: keepPreviousData,
  });
}

export type DashboardExportKind = "report" | "json";

/**
 * Dashboard downloads, one at a time — `exporting` names the one in flight.
 * The lock itself lives in `useExclusiveDownload`.
 *
 * "Download Report" is the CSV, "Export JSON" the JSON — the same pairing as
 * the Orders page, so the brand button means the same file on both.
 */
export function useExportDashboard() {
  const { running: exporting, run } = useExclusiveDownload<DashboardExportKind>();

  // The range is in the name, as on the Orders page: a 7-day file and a
  // 12-month file used to both land as `dashboard-report.csv`.
  const downloadReport = (params?: DashboardQueryParams) =>
    run(
      "report",
      () => dashboardService.exportCsv(params),
      `dashboard-report-${params?.range ?? "all"}.csv`,
      "Couldn't download the report. Please try again.",
    );

  const exportJson = (params?: DashboardQueryParams) =>
    run(
      "json",
      () => dashboardService.exportJson(params),
      `dashboard-export-${params?.range ?? "all"}.json`,
      "Couldn't export the JSON. Please try again.",
    );

  return { downloadReport, exportJson, exporting };
}
