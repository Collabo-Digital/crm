import { apiClient } from "~/lib/api-client";
import type {
  InwardSuppliesResponse,
  InwardSupply,
  UpsertInwardSupplyRequest,
} from "~/types/api";

/**
 * Payment-supplier fees for a filing period, and the GST claimable on them.
 *
 * Separate from `invoiceService` on purpose: these figures sit BESIDE the
 * return, never inside it. Keeping them on their own service makes it harder
 * for a fee to drift into a return total by accident.
 */
export const inwardSupplyService = {
  /** GET /payment-fees?financialYear=&period= */
  list: (financialYear: string, period: string) =>
    apiClient
      .get<InwardSuppliesResponse>("/payment-fees", {
        params: { financialYear, period },
      })
      .then((res) => res.data),

  /**
   * PUT /payment-fees — create or correct one supplier's figure.
   *
   * PUT because the server keys on (year, period, supplier): re-sending a
   * month's total corrects it rather than adding a row that would double the
   * claim.
   */
  upsert: (data: UpsertInwardSupplyRequest) =>
    apiClient.put<InwardSupply>("/payment-fees", data).then((res) => res.data),

  /** DELETE /payment-fees/:id */
  remove: (id: string) =>
    apiClient.delete<{ id: string }>(`/payment-fees/${id}`).then((res) => res.data),
};
