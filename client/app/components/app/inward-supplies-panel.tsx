import { useState } from "react";
import { Plus, Trash2, Loader2, AlertTriangle } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import {
  useInwardSupplies,
  useUpsertInwardSupplyMutation,
  useDeleteInwardSupplyMutation,
} from "~/hooks/use-inward-supply-queries";
import { formatCurrency } from "~/lib/utils";
import type { InwardSupply } from "~/types/api";

/**
 * Payment-supplier fees for the period, and the GST claimable on them.
 *
 * ⚠️ SITS BESIDE THE RETURN, NEVER INSIDE IT. A sale keeps its full declared
 * value however much the supplier deducts before settling — the fee is a
 * separate purchase whose GST comes back as input tax credit. Nothing rendered
 * here is added to or subtracted from any GSTR-1 or GSTR-3B figure.
 *
 * It is also NOT a table-4 ITC line. Gateway fees are a fraction of real input
 * credit (stock, rent, software, freight are the rest), and a fee-only number
 * dressed up as ITC is exactly the kind of authoritative-looking figure that
 * gets filed wrong. It is a report to hand an accountant.
 *
 * Period-level rather than per-order because a third-party supplier's fee is
 * invisible to Shopify and arrives as a monthly statement.
 */
export function InwardSuppliesPanel({
  financialYear,
  period,
  currency,
  canEdit,
}: {
  financialYear: string;
  period: string;
  currency: string;
  canEdit: boolean;
}) {
  const { data, isLoading } = useInwardSupplies(financialYear, period);
  const upsert = useUpsertInwardSupplyMutation();
  const remove = useDeleteInwardSupplyMutation();

  const [showForm, setShowForm] = useState(false);
  const [supplier, setGateway] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [gstAmount, setGstAmount] = useState("");
  const [supplierGstin, setSupplierGstin] = useState("");
  const [isReverseCharge, setIsReverseCharge] = useState(false);

  function resetForm() {
    setGateway("");
    setFeeAmount("");
    setGstAmount("");
    setSupplierGstin("");
    setIsReverseCharge(false);
    setShowForm(false);
  }

  function handleAdd() {
    const fee = Number(feeAmount);
    if (!supplier.trim() || !Number.isFinite(fee) || fee < 0) return;

    // gstAmount stays UNDEFINED when the field is blank. Sending 0 would assert
    // "there is no tax to claim" when the truth is "the invoice does not say".
    const gst = gstAmount.trim() === "" ? undefined : Number(gstAmount);

    upsert.mutate(
      {
        financialYear,
        period,
        supplier: supplier.trim(),
        feeAmount: fee,
        gstAmount: Number.isFinite(gst as number) ? gst : undefined,
        supplierGstin: supplierGstin.trim() || undefined,
        isReverseCharge,
      },
      { onSuccess: resetForm },
    );
  }

  if (isLoading) return null;

  const fees = data?.fees ?? [];
  const summary = data?.summary;
  const money = (amount: number) => formatCurrency(amount, currency);

  return (
    <SectionCard
      title="Purchases &amp; reverse charge"
      description="Gateway fees, foreign subscriptions and ad spend — and the GST you can claim"
    >
      <div className="space-y-4">
        {/* The claimable line — the reason this panel exists. */}
        <div className="rounded-xl bg-info-subtle px-5 py-3 text-caption">
          {summary && summary.totalGst !== null ? (
            <p>
              <strong className="font-semibold">
                GST on purchases this period:{" "}
                {summary.rowsWithUnknownGst > 0 && "at least "}
                {money(summary.totalGst)}
              </strong>{" "}
              — claimable as input tax credit. Only the reverse-charge portion
              reaches the return below; give the rest to your accountant.
            </p>
          ) : (
            <p>
              Nothing recorded for this period. GST on what you buy is claimable
              as input tax credit — add it below so it is not missed.
            </p>
          )}
        </div>

        {/* Reverse charge is the part that DOES reach the return, so say
            exactly which portal boxes it fills. "Tell your accountant" was the
            weak ending this replaces: the figures are known, so name them. */}
        {summary && summary.reverseChargeGst > 0 && (
          <div className="rounded-xl bg-info-subtle px-5 py-3 text-caption">
            <p>
              <strong className="font-semibold">
                On your GSTR-3B: enter {money(summary.reverseChargeTaxable)} and{" "}
                {money(summary.reverseChargeGst)} IGST in{" "}
                <span className="font-mono">3.1(d)</span>, then the same{" "}
                {money(summary.reverseChargeGst)} in{" "}
                <span className="font-mono">4(A)(3)</span>.
              </strong>{" "}
              These are imports of services — you pay that GST yourself and
              reclaim the same amount, so it nets to nothing in cash. Both
              entries are still required, and they are already in the GSTR-3B
              download.
            </p>
          </div>
        )}

        {/* Silence is how a foreign subscription goes undeclared for a year.
            An explicit prompt is what makes someone check. */}
        {summary && summary.reverseChargeGst === 0 && (
          <div className="flex items-start gap-2 rounded-xl bg-muted px-5 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-caption text-muted-foreground">
              <strong className="font-medium text-foreground">
                Paid any foreign service this period?
              </strong>{" "}
              Shopify, Google Ads, Meta, AWS and similar are liable to reverse
              charge — you owe the GST yourself and reclaim it. Record them here
              and both entries appear on your GSTR-3B.
            </p>
          </div>
        )}

        {/* Unknown GST must announce itself: the total above is a floor, and a
            reader who cannot see that will treat it as the whole claim. */}
        {summary && summary.rowsWithUnknownGst > 0 && (
          <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-5 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-caption">
              <strong className="font-semibold">
                {summary.rowsWithUnknownGst}{" "}
                {summary.rowsWithUnknownGst === 1 ? "entry has" : "entries have"}{" "}
                no GST amount.
              </strong>{" "}
              The figure above is a floor, not the full claim. Add the tax from
              the supplier&rsquo;s invoice.
            </p>
          </div>
        )}

        {fees.length > 0 && (
          <div className="space-y-2">
            {fees.map((fee: InwardSupply) => (
              <div
                key={fee.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="text-caption font-medium text-foreground">
                    {fee.supplier}
                    {fee.isReverseCharge && (
                      <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-medium text-warning-strong">
                        Reverse charge
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Fee {money(Number(fee.feeAmount))} · GST{" "}
                    {fee.gstAmount === null ? (
                      <span className="text-warning">not stated</span>
                    ) : (
                      money(Number(fee.gstAmount))
                    )}
                    {fee.supplierGstin && ` · ${fee.supplierGstin}`}
                  </p>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove.mutate(fee.id)}
                    aria-label={`Remove ${fee.supplier} fee`}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-danger-subtle hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit && !showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 text-caption text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
          >
            <Plus className="size-3.5" /> Add supplier fee
          </button>
        )}

        {canEdit && showForm && (
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[10px] font-medium text-muted-foreground">
                  Gateway
                </span>
                <input
                  value={supplier}
                  onChange={(e) => setGateway(e.target.value)}
                  placeholder="Shopify Payments, Razorpay…"
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-muted-foreground">
                  Supplier GSTIN (optional)
                </span>
                <input
                  value={supplierGstin}
                  onChange={(e) => setSupplierGstin(e.target.value)}
                  placeholder="29AABCU9603R1ZM"
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 font-mono text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-muted-foreground">
                  Fee charged (excluding tax)
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={feeAmount}
                  onChange={(e) => setFeeAmount(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-muted-foreground">
                  GST on the fee
                  <span className="ml-1 font-normal">
                    — leave blank if the invoice does not state it
                  </span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={gstAmount}
                  onChange={(e) => setGstAmount(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </label>
            </div>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={isReverseCharge}
                onChange={(e) => setIsReverseCharge(e.target.checked)}
                className="mt-0.5 size-3.5 rounded border-input"
              />
              <span className="text-micro text-muted-foreground">
                <span className="font-medium text-foreground">
                  Reverse charge (import of services)
                </span>{" "}
                — tick when the invoice carries no Indian GSTIN. You pay the GST
                yourself and reclaim the same amount.
              </span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAdd}
                disabled={upsert.isPending || !supplier.trim() || !feeAmount}
                className="inline-flex h-9 items-center gap-1 rounded-lg bg-brand px-3 text-caption font-medium text-brand-foreground disabled:opacity-50"
              >
                {upsert.isPending && <Loader2 className="size-3 animate-spin" />}
                Save
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="h-9 rounded-lg px-3 text-caption text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
