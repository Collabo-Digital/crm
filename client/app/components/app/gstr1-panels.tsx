import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SectionCard } from "~/components/app/section-card";
import { EmptyState } from "~/components/app/empty-state";
import { formatCurrency } from "~/lib/utils";
import { b2bSectionTotals } from "~/lib/gst-return";
import type { GstReturnGstr1 } from "~/types/api";

/** Rows shown before the "show all" toggle appears. */
const COLLAPSED_ROWS = 4;

interface PanelProps {
  data: GstReturnGstr1;
  currency: string;
}

/** Right-aligned section total, rendered in the card header. */
function SectionTotal({ amount, currency }: { amount: number; currency: string }) {
  return (
    <span className="text-body font-semibold tabular-nums text-foreground">
      {formatCurrency(amount, currency, { maximumFractionDigits: 0 })}
    </span>
  );
}

/**
 * A zero rendered as an em dash.
 *
 * A column of "₹0.00" reads like a filed figure; a dash reads like "nothing
 * here", which is what it means. Mirrors the helper in gstr3b-panels.
 */
function Amount({ value, currency }: { value: number; currency: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <>{formatCurrency(value, currency, { maximumFractionDigits: 0 })}</>;
}

function ShowAllButton({
  expanded,
  hiddenCount,
  noun,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  noun: string;
  onToggle: () => void;
}) {
  if (hiddenCount <= 0) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full border-t px-5 py-3 text-left text-caption font-medium text-brand-strong transition-colors hover:text-brand-strong-hover"
    >
      {expanded ? "Show fewer" : `Show all ${hiddenCount + COLLAPSED_ROWS} ${noun}`}
    </button>
  );
}

/**
 * 4A — invoice-wise outward supplies to registered buyers, grouped by GSTIN.
 *
 * The per-invoice rows were fetched and thrown away: this panel rendered only
 * buyer-level counts and totals while the page subtitle, this comment and the
 * card description all claimed "invoice-wise". Expanding a buyer now shows the
 * invoices that were already on the wire.
 */
export function Gstr1B2bPanel({ data, currency }: PanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [openBuyer, setOpenBuyer] = useState<string | null>(null);

  const totals = b2bSectionTotals(data.b2b);
  const rows = expanded ? data.b2b : data.b2b.slice(0, COLLAPSED_ROWS);

  return (
    <SectionCard
      title="4A · B2B invoices"
      description={`Registered buyers · ${totals.invoiceCount} invoices`}
      action={<SectionTotal amount={totals.totalTaxable} currency={currency} />}
    >
      {data.b2b.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No B2B invoices"
            description="No invoices in this period carry a buyer GSTIN."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Buyer GSTIN</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Invoices</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => {
                  const isOpen = openBuyer === entry.buyerGstin;
                  return (
                    <Fragment key={entry.buyerGstin}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setOpenBuyer(isOpen ? null : entry.buyerGstin)
                        }
                      >
                        <TableCell className="font-mono text-caption">
                          {/* The keyboard way in; the row stays clickable. */}
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenBuyer(isOpen ? null : entry.buyerGstin);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-sm"
                          >
                            {isOpen ? (
                              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="sr-only">Invoices for </span>
                            {entry.buyerGstin}
                          </button>
                        </TableCell>
                        <TableCell>{entry.buyerName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {entry.invoiceCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(entry.totalTaxable, currency, {
                            maximumFractionDigits: 0,
                          })}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(entry.totalTax, currency, {
                            maximumFractionDigits: 0,
                          })}
                        </TableCell>
                      </TableRow>

                      {isOpen &&
                        entry.invoices.map((inv) => (
                          <TableRow
                            key={inv.invoiceNumber}
                            className="bg-muted/40"
                          >
                            <TableCell className="pl-9 font-mono text-micro">
                              {inv.invoiceNumber}
                            </TableCell>
                            <TableCell className="text-micro text-muted-foreground">
                              {new Date(inv.invoiceDate).toLocaleDateString(
                                "en-IN",
                              )}
                              {inv.placeOfSupply ? (
                                <>
                                  {" · "}
                                  {inv.placeOfSupply} {inv.placeOfSupplyName}
                                </>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right text-micro text-muted-foreground">
                              {inv.gstType === "IGST" ? "Inter" : "Intra"}
                              {/* Table 4B rather than 4A — the recipient pays
                                  this tax, so it is excluded from GSTR-3B
                                  3.1(a) and from tax payable. */}
                              {inv.reverseCharge && (
                                <span
                                  className="ml-1 rounded bg-warning-subtle px-1 py-0.5 text-[10px] font-medium text-warning-strong"
                                  title="Reverse charge — tax payable by the recipient (table 4B)"
                                >
                                  RCM
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-micro tabular-nums">
                              {formatCurrency(inv.subtotal, currency, {
                                maximumFractionDigits: 0,
                              })}
                            </TableCell>
                            <TableCell className="text-right text-micro tabular-nums">
                              {formatCurrency(inv.totalTax, currency, {
                                maximumFractionDigits: 0,
                              })}
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <ShowAllButton
            expanded={expanded}
            hiddenCount={data.b2b.length - COLLAPSED_ROWS}
            noun="buyers"
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </SectionCard>
  );
}

/**
 * 5 — B2CL. Inter-State supplies to unregistered persons above the invoice-value
 * threshold, reported INVOICE-WISE rather than summarised.
 */
export function Gstr1B2clPanel({ data, currency }: PanelProps) {
  const total = data.b2cl.reduce((sum, r) => sum + r.taxableValue, 0);

  return (
    <SectionCard
      title="5 · B2CL"
      description="Large inter-State B2C invoices"
      action={<SectionTotal amount={total} currency={currency} />}
    >
      {data.b2cl.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No large B2C invoices"
            description="No inter-State consumer invoice in this period exceeds the threshold."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Place of supply</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">IGST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.b2cl.map((row, i) => (
                <TableRow key={`${row.invoiceNumber}-${row.gstRate}-${i}`}>
                  <TableCell className="font-mono text-caption">
                    {row.invoiceNumber}
                  </TableCell>
                  <TableCell>
                    {row.placeOfSupplyName}{" "}
                    <span className="text-muted-foreground">
                      ({row.placeOfSupply})
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.gstRate}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.taxableValue, currency, {
                      maximumFractionDigits: 0,
                    })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Amount value={row.igst} currency={currency} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * 7 — B2CS, by place of supply AND rate.
 *
 * Replaces a single row per state that mixed every rate together. That row was
 * unfilable: GSTR-1 has no place to report "₹57,700 in Maharashtra" without
 * saying at what rate.
 */
export function Gstr1B2csPanel({ data, currency }: PanelProps) {
  const [expanded, setExpanded] = useState(false);

  const total = data.b2cs.reduce((sum, r) => sum + r.taxableValue, 0);
  const rows = expanded ? data.b2cs : data.b2cs.slice(0, COLLAPSED_ROWS);

  return (
    <SectionCard
      title="7 · B2CS"
      description="By place of supply and rate"
      action={<SectionTotal amount={total} currency={currency} />}
    >
      {data.b2cs.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No B2C supplies"
            description="No consumer invoices in this period."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Place of supply</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.placeOfSupply}-${row.gstRate}`}>
                    <TableCell>
                      {row.placeOfSupplyName}{" "}
                      <span className="text-muted-foreground">
                        ({row.placeOfSupply})
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.gstRate}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.taxableValue, currency, {
                        maximumFractionDigits: 0,
                      })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Amount
                        value={row.cgst + row.sgst + row.igst}
                        currency={currency}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ShowAllButton
            expanded={expanded}
            hiddenCount={data.b2cs.length - COLLAPSED_ROWS}
            noun="rows"
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </SectionCard>
  );
}

/**
 * 8 — supplies attracting no tax.
 *
 * Nil-rated, exempted and non-GST are three legally distinct statuses that all
 * resolve to zero tax, so they are classified on the product rather than
 * inferred from the rate. Nothing tracked them before, so this table did not
 * exist.
 */
export function Gstr1NilRatedPanel({ data, currency }: PanelProps) {
  if (!data.nilRated?.length) return null;

  return (
    <SectionCard
      title="8 · Nil-rated, exempt and non-GST"
      description="Supplies attracting no tax"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Section</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Nil rated</TableHead>
              <TableHead className="text-right">Exempted</TableHead>
              <TableHead className="text-right">Non-GST</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.nilRated.map((row) => (
              <TableRow key={row.section}>
                <TableCell className="font-mono text-caption">
                  {row.section}
                </TableCell>
                <TableCell className="text-caption text-muted-foreground">
                  {row.description}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Amount value={row.nilRated} currency={currency} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Amount value={row.exempted} currency={currency} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Amount value={row.nonGst} currency={currency} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

/**
 * 12 — HSN summary, by HSN AND rate, with a unit quantity code.
 *
 * Was a three-field list (code, quantity, tax) grouped by HSN alone. Table 12
 * requires the rate, the UQC, the total value and the tax split, and one code
 * sold at two rates is two statutory rows.
 */
/**
 * Table 13 — documents issued. Mandatory in GSTR-1 whenever outward supplies
 * are reported, and derived entirely from the invoice numbers: there is no
 * sequence column, so the serial range IS the record.
 */
export function Gstr1DocumentsPanel({ data }: PanelProps) {
  const summary = data.documentsIssued;
  if (!summary) return null;

  const gaps = summary.rows.filter((r) => r.total !== r.documents);

  return (
    <SectionCard
      title="13 · Documents issued"
      description="Serial ranges per series, with cancellations"
    >
      {(gaps.length > 0 || summary.unparsed > 0) && (
        <div className="flex items-start gap-2 border-b bg-warning-subtle px-5 py-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-caption">
            {gaps.length > 0 && (
              <>
                <strong className="font-semibold">
                  {gaps.length === 1 ? "A series has" : `${gaps.length} series have`}{" "}
                  fewer documents than its serial range covers.
                </strong>{" "}
                Either numbers are genuinely missing, or you are viewing one
                GSTIN while the numbering series runs across the whole business.{" "}
              </>
            )}
            {summary.unparsed > 0 && (
              <>
                {summary.unparsed} invoice number
                {summary.unparsed === 1 ? "" : "s"} could not be read as a
                series and serial, so {summary.unparsed === 1 ? "it is" : "they are"}{" "}
                not counted here.
              </>
            )}
          </p>
        </div>
      )}

      {summary.rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-caption text-muted-foreground">
          No documents issued in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nature</TableHead>
                <TableHead>Series</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Cancelled</TableHead>
                <TableHead className="text-right">Net issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.rows.map((row) => (
                <TableRow key={`${row.series}-${row.financialYear}`}>
                  <TableCell className="text-caption">{row.nature}</TableCell>
                  <TableCell className="font-mono text-caption">
                    {row.series}
                    <span className="ml-1 text-micro text-muted-foreground">
                      {row.financialYear}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-caption">{row.from}</TableCell>
                  <TableCell className="font-mono text-caption">{row.to}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.total}
                    {row.total !== row.documents && (
                      <span
                        className="ml-1 text-micro text-warning"
                        title={`${row.documents} documents present in this view`}
                      >
                        ({row.documents})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.cancelled}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.netIssued}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

export function Gstr1HsnPanel({ data, currency }: PanelProps) {
  const [expanded, setExpanded] = useState(false);

  const missing = data.totals?.linesMissingHsn ?? 0;
  const total = data.hsnSummary.reduce((sum, r) => sum + r.taxableValue, 0);

  // The portal reports Table 12 as two tabs, each reconciling to its own
  // supplies. Collapsing is applied PER GROUP, not across the merged array —
  // otherwise a long B2B list would hide the B2C table entirely.
  const b2b = data.hsnSummary.filter((r) => r.recipientType === "B2B");
  const b2c = data.hsnSummary.filter((r) => r.recipientType !== "B2B");
  const groups = [
    { label: "B2B — registered buyers", rows: b2b },
    { label: "B2C — unregistered buyers", rows: b2c },
  ].filter((g) => g.rows.length > 0);
  const visible = (rows: typeof data.hsnSummary) =>
    expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  const hiddenCount = groups.reduce(
    (sum, g) => sum + Math.max(g.rows.length - COLLAPSED_ROWS, 0),
    0,
  );

  return (
    <SectionCard
      title="12 · HSN summary"
      description="B2B and B2C, by HSN code and rate"
      action={<SectionTotal amount={total} currency={currency} />}
    >
      {missing > 0 && (
        // Named, not hidden. The old code invented the HSN '0000' here, which
        // is not a valid code and went onto a statutory document.
        <div className="flex items-start gap-2 border-b bg-warning-subtle px-5 py-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-caption">
            <strong className="font-semibold">
              {missing} {missing === 1 ? "line has" : "lines have"} no HSN code.
            </strong>{" "}
            Table 12 cannot be filed until every product is classified. Add HSN
            codes on the products, then reissue those invoices.
          </p>
        </div>
      )}

      {data.hsnSummary.length === 0 ? (
        <div className="p-8">
          <EmptyState
            title="No line items"
            description="No invoices in this period."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>HSN</TableHead>
                  <TableHead>UQC</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.flatMap((group) => [
                  // A labelled divider rather than two tables: the columns are
                  // identical, and one header row keeps them comparable.
                  <TableRow key={`head-${group.label}`} className="bg-muted/40">
                    <TableCell
                      colSpan={6}
                      className="py-1.5 text-micro font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {group.label}
                    </TableCell>
                  </TableRow>,
                  ...visible(group.rows).map((row, i) => (
                  <TableRow key={`${group.label}-${row.hsnCode ?? "none"}-${row.uqc}-${row.gstRate}-${i}`}>
                    <TableCell className="font-mono text-caption">
                      {row.hsnCode ?? (
                        <span className="font-sans text-warning">Missing</span>
                      )}
                      {/* The description goes onto the filed return but was
                          shown nowhere, so a wrong one could only be caught by
                          opening the downloaded CSV. Beneath the code rather
                          than in its own column — this table is already the
                          widest in the view. */}
                      {row.description && (
                        <span
                          className="mt-0.5 block truncate font-sans text-[10px] font-normal text-muted-foreground"
                          title={row.description}
                        >
                          {row.description}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-caption text-muted-foreground">
                      {row.uqc}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.gstRate}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.quantity.toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.taxableValue, currency, {
                        maximumFractionDigits: 0,
                      })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Amount
                        value={row.cgst + row.sgst + row.igst}
                        currency={currency}
                      />
                    </TableCell>
                  </TableRow>
                  )),
                ])}
              </TableBody>
            </Table>
          </div>
          <ShowAllButton
            expanded={expanded}
            hiddenCount={hiddenCount}
            noun="rows"
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </SectionCard>
  );
}

/**
 * 9B — credit notes against earlier invoices.
 *
 * The table that did not exist. Refunds carried no tax at all, so a refunded
 * sale stayed 100% in declared output liability for ever — any merchant who
 * accepts returns had been over-declaring every month.
 *
 * CDNR (registered buyer) and CDNUR (unregistered) are separate tables on the
 * form and are labelled per row rather than split into two cards, because most
 * periods have only a handful of notes.
 */
export function Gstr1CreditNotePanel({ data, currency }: PanelProps) {
  const notes = data.creditNotes ?? [];
  const total = notes.reduce((sum, n) => sum + n.taxableValue, 0);

  if (notes.length === 0) return null;

  return (
    <SectionCard
      title="9B · Credit notes"
      description={`Reversing ${notes.length} ${notes.length === 1 ? "invoice" : "invoices"}`}
      action={<SectionTotal amount={total} currency={currency} />}
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Note</TableHead>
              <TableHead>Against</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">Tax</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {notes.map((n) => (
              <TableRow key={n.noteNumber}>
                <TableCell className="font-mono text-caption">
                  {n.noteNumber}
                </TableCell>
                <TableCell className="font-mono text-micro text-muted-foreground">
                  {n.originalInvoiceNumber ?? "—"}
                </TableCell>
                <TableCell>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
                    {n.section}
                  </span>
                </TableCell>
                <TableCell className="text-caption text-muted-foreground">
                  {n.reason ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {/* Shown positive, as on the paper document. The return
                      subtracts them; a minus sign here would read as a second
                      negation. */}
                  {formatCurrency(n.taxableValue, currency, {
                    maximumFractionDigits: 0,
                  })}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Amount
                    value={n.cgst + n.sgst + n.igst}
                    currency={currency}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
