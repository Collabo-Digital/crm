import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SectionCard } from "~/components/app/section-card";
import { EmptyState } from "~/components/app/empty-state";
import { formatCurrency } from "~/lib/utils";
import { outwardSupplyTotals } from "~/lib/gst-return";
import type { GstReturnGstr3B } from "~/types/api";

interface PanelProps {
  data: GstReturnGstr3B;
  currency: string;
}

/**
 * Zero renders as an em dash, matching the statutory forms — a column of
 * "₹0" reads as a filed figure, whereas a dash reads as "nothing under this
 * head", which is what a zero here actually means.
 */
function Amount({ value, currency }: { value: number; currency: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <>{formatCurrency(value, currency, { maximumFractionDigits: 0 })}</>;
}

/**
 * 3.1(a) — outward taxable supplies, broken down by GST rate.
 *
 * This used to be the WHOLE of 3.1, with a note admitting that supply-nature
 * classification was not tracked: every line landed in row (a) and (b), (c) and
 * (e) were permanently empty. Products now carry a supply type, so those rows
 * are real and live in Gstr3bOtherSuppliesPanel below.
 *
 * Row (d), inward supplies liable to reverse charge, is filled by the service
 * from recorded inward supplies and rendered by InwardSuppliesPanel. OUTWARD
 * supplies under reverse charge are a different thing again — see
 * Gstr3bOutwardReverseChargePanel below.
 */
export function Gstr3bOutwardPanel({ data, currency }: PanelProps) {
  const totals = outwardSupplyTotals(data.outwardSupplies);

  return (
    <SectionCard
      title="3.1(a) · Outward taxable supplies"
      description="By GST rate"
    >
      {data.outwardSupplies.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No outward supplies"
            description="Issued invoices in this period will appear here."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>GST rate</TableHead>
                <TableHead className="text-right">Taxable value</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
                <TableHead className="text-right">Total tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.outwardSupplies.map((row) => (
                <TableRow key={row.gstRate} className="hover:bg-transparent">
                  <TableCell className="text-caption font-medium text-foreground">
                    {row.gstRate}%
                  </TableCell>
                  <TableCell className="text-right text-caption tabular-nums text-foreground">
                    <Amount value={row.taxableValue} currency={currency} />
                  </TableCell>
                  <TableCell className="text-right text-caption tabular-nums text-foreground">
                    <Amount value={row.igst} currency={currency} />
                  </TableCell>
                  <TableCell className="text-right text-caption tabular-nums text-foreground">
                    <Amount value={row.cgst} currency={currency} />
                  </TableCell>
                  <TableCell className="text-right text-caption tabular-nums text-foreground">
                    <Amount value={row.sgst} currency={currency} />
                  </TableCell>
                  <TableCell className="text-right text-caption font-medium tabular-nums text-foreground">
                    <Amount value={row.totalTax} currency={currency} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="text-caption font-semibold text-foreground">
                  Total
                </TableCell>
                <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                  <Amount value={totals.taxableValue} currency={currency} />
                </TableCell>
                <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                  <Amount value={totals.igst} currency={currency} />
                </TableCell>
                <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                  <Amount value={totals.cgst} currency={currency} />
                </TableCell>
                <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                  <Amount value={totals.sgst} currency={currency} />
                </TableCell>
                <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                  <Amount value={totals.totalTax} currency={currency} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

/** 3.2 — inter-state supplies to unregistered persons, by place of supply. */
export function Gstr3bInterStatePanel({ data, currency }: PanelProps) {
  const rows = data.interState.byState;

  return (
    <SectionCard
      title="3.2 · Inter-state supplies to unregistered persons"
      description="By place of supply"
    >
      {rows.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No inter-state B2C supplies"
            description="IGST invoices to buyers without a GSTIN will appear here."
          />
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.placeOfSupply}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <span className="truncate text-caption font-medium text-foreground">
                {row.placeOfSupplyName} ({row.placeOfSupply})
              </span>
              <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                {formatCurrency(row.totalTaxable, currency, {
                  maximumFractionDigits: 0,
                })}
              </span>
              <span className="shrink-0 text-caption font-medium tabular-nums text-foreground">
                {formatCurrency(row.totalIgst, currency, {
                  maximumFractionDigits: 0,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * 3.1(b), (c) and (e) — supplies that carry no tax.
 *
 * Taxable value only, by design: none of these three attracts tax, so a tax
 * column would be a column of zeros. They were impossible to report before
 * products carried a supply type, because nil-rated, exempted and non-GST all
 * resolve to a 0% rate and could not be told apart from each other.
 */
/**
 * Outward supplies the RECIPIENT pays tax on — GSTR-1 table 4B.
 *
 * Deliberately NOT part of 3.1(a): the portal's system-computed 3.1(a) is built
 * from GSTR-1 tables 4A/4C/5/6C/7/9/10/11 and omits 4B, because the supplier
 * owes nothing on these and the recipient declares the same tax in their own
 * 3.1(d). Shown so the exclusion is visible and reconcilable rather than an
 * unexplained shortfall against the sales figures.
 *
 * Hidden entirely when there are none, which is the overwhelming majority of
 * merchants — an always-zero row would invite the question every month.
 */
export function Gstr3bOutwardReverseChargePanel({ data, currency }: PanelProps) {
  const rcm = data.outwardReverseCharge;
  if (!rcm || rcm.invoiceCount === 0) return null;

  return (
    <SectionCard
      title="Outward supplies under reverse charge"
      description="Reported in GSTR-1 table 4B — excluded from 3.1(a) and from tax payable"
    >
      <div className="space-y-3 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted-foreground">
            {rcm.invoiceCount} invoice{rcm.invoiceCount === 1 ? "" : "s"}
          </span>
          <span className="text-caption font-semibold tabular-nums">
            {formatCurrency(rcm.taxableValue, currency)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted-foreground">
            Tax payable by the recipient, not by you
          </span>
          <span className="text-caption font-semibold tabular-nums">
            {formatCurrency(rcm.tax, currency)}
          </span>
        </div>
        {rcm.unregisteredRecipients > 0 && (
          <p className="rounded-md bg-warning-subtle px-3 py-2 text-caption">
            <strong className="font-semibold">
              {rcm.unregisteredRecipients} of these have no buyer GSTIN.
            </strong>{" "}
            Reverse charge on outward supplies applies between registered
            persons, so check whether those invoices were flagged by mistake.
          </p>
        )}
        <p className="text-micro text-muted-foreground">
          Confirm the treatment with your CA before filing.
        </p>
      </div>
    </SectionCard>
  );
}

export function Gstr3bOtherSuppliesPanel({ data, currency }: PanelProps) {
  const rows = [
    {
      key: "zero",
      label: "(b) Zero-rated supplies (exports, SEZ)",
      value: data.otherSupplies?.zeroRated ?? 0,
      // Only this row can carry tax: an export without an LUT is zero-rated
      // but made ON PAYMENT of IGST. Nil-rated and non-GST never do, so their
      // cell stays blank rather than showing a zero that reads as a figure.
      igst: data.otherSupplies?.zeroRatedIgst ?? 0,
    },
    {
      key: "nil",
      label: "(c) Nil-rated and exempted supplies",
      value: data.otherSupplies?.nilRatedExempt ?? 0,
      igst: null,
    },
    {
      key: "nongst",
      label: "(e) Non-GST outward supplies",
      value: data.otherSupplies?.nonGst ?? 0,
      igst: null,
    },
  ];

  // Nothing to report is worth saying once, rather than as three zero rows that
  // read like filed figures.
  if (rows.every((r) => !r.value)) return null;

  return (
    <SectionCard
      title="3.1(b)(c)(e) · Other outward supplies"
      description="Zero-rated, nil-rated/exempt and non-GST"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nature of supply</TableHead>
              <TableHead className="text-right">Taxable value</TableHead>
              <TableHead className="text-right">IGST</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>{row.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Amount value={row.value} currency={currency} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.igst == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Amount value={row.igst} currency={currency} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
