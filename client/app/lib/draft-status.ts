import type { DraftOrderStatus } from "~/types/api";
import { toneClasses } from "./status-tone.ts";

/**
 * Canonical draft-status pill styling and labels.
 *
 * These maps were copy-pasted into both `orders/drafts.tsx` and
 * `orders/drafts/$id.tsx`, and the `COMPLETED` entry hardcoded the brand hex
 * (`bg-[#CEF17B]/30 text-[#084734]`) — which does not flip in dark mode, where
 * `--brand-strong` inverts to lime. One source now, on tokens, imported by both.
 *
 * Same shape as `order-status.ts`, for the same reason.
 */

export const DRAFT_STATUS_CLASSES = toneClasses<DraftOrderStatus>({
  OPEN: "info",
  INVOICE_SENT: "attention",
  COMPLETED: "success",
});

export const DRAFT_STATUS_LABELS: Record<DraftOrderStatus, string> = {
  OPEN: "Open",
  INVOICE_SENT: "Invoice sent",
  COMPLETED: "Completed",
};
