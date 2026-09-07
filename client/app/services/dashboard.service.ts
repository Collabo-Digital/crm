import { apiClient } from "~/lib/api-client";
import type {
  DashboardOverview,
  DashboardPeriod,
  DashboardQueryParams,
  StatMetric,
  CurrencyAmount,
} from "~/types/api";

/**
 * One bucket of the sales-and-profit series — a month, or a day on the 30-day
 * range.
 */
export interface SalesProfitPoint {
  /** Axis label. "Jan", or "3 Sep" on daily buckets. */
  bucket: string;
  /** "2026-01" / "2026-01-03". Labels collide across years; this does not. */
  bucketKey: string;

  /** What customers paid, tax and shipping included. */
  grossSales: number;
  tax: number;
  shipping: number;
  refunds: number;
  /** Post-discount, pre-tax, pre-shipping, net of refunds. */
  netSales: number;
  /** The slice of `netSales` backed by a known cost — the profit denominator. */
  netSalesWithCost: number;
  cogs: number;
  /**
   * `netSalesWithCost − cogs`. NULL, never 0, when nothing sold in this bucket
   * has a cost price set: the honest answer there is "unknown", not "zero".
   */
  grossProfit: number | null;
  /** 0–1. Share of net sales backed by a known cost. */
  costCoverage: number;

  orders: number;
  newCustomers: number;
}

export interface SalesProfitTotals extends Omit<SalesProfitPoint, "bucket" | "bucketKey"> {
  /** `grossProfit ÷ netSalesWithCost × 100`. NULL whenever `grossProfit` is. */
  grossMarginPct: number | null;
  /**
   * The currency every money figure here has been converted into — the org's
   * own. Each order is converted at the rate stored on it, captured at that
   * order's date, so a past window returns the same figure every time.
   */
  currency: string;
  /** Pre-conversion make-up of `grossSales`, largest first. Detail only. */
  salesByCurrency: CurrencyAmount[];
  /**
   * Orders excluded from every figure above because their rate never
   * resolved. >0 means the totals are incomplete and the UI says so.
   */
  unconvertedOrders: number;
}

export interface SalesProfitData {
  period: DashboardPeriod;
  data: SalesProfitPoint[];
  /**
   * The stat cards read from here, not from `/dashboard`, so the headline
   * figures and the bars beside them are the same numbers by construction.
   */
  totals: SalesProfitTotals;
  /** Against the equally long window before this one. NULL when profit is. */
  profitTrend: StatMetric | null;
}

export interface SalesByCategoryData {
  data: Array<{ name: string; value: number; color: string }>;
  total: number;
}

export const dashboardService = {
  getOverview: (params?: DashboardQueryParams) =>
    apiClient
      .get<DashboardOverview>("/dashboard", { params })
      .then((response) => response.data),

  getSalesAndProfit: (params?: DashboardQueryParams) =>
    apiClient
      .get<SalesProfitData>("/dashboard/monthly-sales", { params })
      .then((response) => response.data),

  getSalesByCategory: (params?: DashboardQueryParams) =>
    apiClient
      .get<SalesByCategoryData>("/dashboard/sales-by-category", { params })
      .then((response) => response.data),

  exportCsv: (params?: DashboardQueryParams) =>
    apiClient
      .get<Blob>("/dashboard/export/csv", { params, responseType: "blob" })
      .then((response) => response.data),

  exportJson: (params?: DashboardQueryParams) =>
    apiClient
      .get<Blob>("/dashboard/export/json", { params, responseType: "blob" })
      .then((response) => response.data),
};
