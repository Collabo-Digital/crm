import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useGenerateSkusMutation } from "~/hooks/use-inventory-mutations";
import { COMMON_UQC, GST_RATE_OPTIONS, GST_SUPPLY_TYPES } from "~/lib/gst-uqc";
import { CODE_TERMS } from "~/lib/inventory-vocabulary";
import { cn, formatMargin } from "~/lib/utils";
import {
  changedVariantFields,
  toInputNumber,
  VARIANT_FIELD_LABELS,
  type VariantDraft,
} from "~/lib/variant-draft";
import { formatVariantOptionLabel, type ProductTaxDefaults } from "~/lib/variant-grouping";
import type { ProductStatus, ProductVariant } from "~/types/api";
import { VariantWarehouseStockEditor } from "./variant-warehouse-stock-editor";

/** Radix Select reserves "" for "nothing selected", so inherit needs a sentinel. */
const INHERIT = "__inherit";

/** Per-warehouse AVAILABLE for one variant, as seeded and as typed. */
export type WarehouseDraft = {
  baseline: Record<string, string>;
  form: Record<string, string>;
};

/**
 * Whether this variant is actually purchasable, and why.
 *
 * There is no per-variant status column — sellability falls out of the product
 * status, the two inventory switches and the stock on hand. So this reports
 * rather than edits: a dropdown here would be a control with nowhere to write,
 * and a second, conflicting UI for the two switches below.
 */
function deriveAvailability(
  form: VariantDraft,
  productStatus: ProductStatus,
  stock: number,
): { label: string; tone: string; reason: string } {
  if (productStatus !== "ACTIVE") {
    return {
      label: productStatus === "DRAFT" ? "Draft" : "Archived",
      tone: "text-muted-foreground",
      reason: "The product itself isn't active, so no variant is on sale.",
    };
  }
  if (!form.trackQuantity) {
    return {
      label: "Active",
      tone: "text-success",
      reason: "Stock isn't tracked for this variant.",
    };
  }
  if (form.continueSelling) {
    return {
      label: "Active",
      tone: "text-success",
      reason: "Keeps selling past zero stock.",
    };
  }
  if (stock > 0) {
    return { label: "Active", tone: "text-success", reason: `${stock} in stock.` };
  }
  return {
    label: "Out of stock",
    tone: "text-warning",
    reason: "Turn on “Keep selling at zero” to keep taking orders.",
  };
}

/**
 * The expanding "EDITING …" panel under a variant row.
 *
 * Controlled: the draft and the per-warehouse quantities live on the product
 * page, so closing the panel or opening another row loses nothing, and the
 * page's one Save sends them with everything else.
 */
export function VariantInlineEditor({
  variant,
  draft,
  baseline,
  warehouseQty,
  productTax,
  productStatus,
  currency,
  colSpan,
  warehousingEnabled,
  trackForced,
  oversellForced,
  isVendor,
  disabled,
  onChange,
  onWarehouseChange,
  onLevelsLoaded,
  onRevert,
  onClose,
}: {
  variant: ProductVariant;
  draft: VariantDraft;
  /** The draft as last saved — what Revert goes back to. */
  baseline: VariantDraft;
  warehouseQty: WarehouseDraft | undefined;
  productTax: ProductTaxDefaults;
  productStatus: ProductStatus;
  currency: string;
  colSpan: number;
  warehousingEnabled: boolean;
  trackForced: boolean;
  oversellForced: boolean;
  isVendor: boolean;
  /** The page is saving. */
  disabled: boolean;
  onChange: (patch: Partial<VariantDraft>) => void;
  onWarehouseChange: (warehouseId: string, value: string) => void;
  /** Seeds the page's per-warehouse draft; see VariantWarehouseStockEditor. */
  onLevelsLoaded: (seed: Record<string, string>) => void;
  onRevert: () => void;
  onClose: () => void;
}) {
  const [advanced, setAdvanced] = useState(true);
  const generateSkus = useGenerateSkusMutation();

  const changes = changedVariantFields(baseline, draft, { warehousingEnabled }).map(
    (key) => VARIANT_FIELD_LABELS[key],
  );
  if (
    warehouseQty &&
    Object.keys(warehouseQty.form).some(
      (id) => warehouseQty.form[id] !== warehouseQty.baseline[id],
    )
  ) {
    changes.push("stock");
  }
  const dirty = changes.length > 0;

  const trackQuantity = trackForced ? true : draft.trackQuantity;
  const optionLabel = formatVariantOptionLabel(variant) ?? variant.title;

  const shownStock = warehousingEnabled
    ? (variant.inventoryQuantity ?? 0)
    : Number.parseInt(draft.inventoryQuantity, 10) || 0;
  const availability = deriveAvailability(draft, productStatus, shownStock);

  return (
    <tr>
      <td colSpan={colSpan} className="border-b bg-card px-6 py-5">
        <p className="text-micro uppercase tracking-wider text-muted-foreground">
          Editing {optionLabel}
        </p>

        {/* ── Always visible ─────────────────────────────────────────── */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={`Price (${currency})`} htmlFor="vie-price">
            <Input
              id="vie-price"
              type="number"
              min="0"
              step="0.01"
              value={draft.price}
              onChange={(e) => onChange({ price: e.target.value })}
              disabled={disabled}
            />
          </Field>

          <Field
            label="Stock"
            htmlFor="vie-stock"
            hint={
              warehousingEnabled ? "Total on hand — set it per warehouse below." : undefined
            }
          >
            <Input
              id="vie-stock"
              type="number"
              min="0"
              step="1"
              value={
                warehousingEnabled
                  ? toInputNumber(variant.inventoryQuantity ?? 0)
                  : draft.inventoryQuantity
              }
              onChange={(e) => onChange({ inventoryQuantity: e.target.value })}
              disabled={disabled || warehousingEnabled || !trackQuantity}
            />
          </Field>

          {/* No aria-invalid on an empty SKU any more: the field flagged
              itself as an error while offering no way to resolve one, which
              is a large part of why this screen felt broken. The Create
              button is the resolution. */}
          <Field label="SKU" htmlFor="vie-sku" hint={CODE_TERMS.sku.definition}>
            <div className="flex gap-2">
              <Input
                id="vie-sku"
                value={draft.sku}
                placeholder="Add a SKU"
                className="font-mono"
                onChange={(e) => onChange({ sku: e.target.value })}
                disabled={disabled}
              />
              {!draft.sku.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={disabled || generateSkus.isPending}
                  // The mutation stays pending until the product refetch lands;
                  // the minted SKU then flows into the page's draft (untouched
                  // fields absorb server values), with the panel left open.
                  onClick={() => generateSkus.mutate({ variantIds: [variant.id] })}
                >
                  {generateSkus.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  Create
                </Button>
              )}
            </div>
          </Field>

          {/* Reported, not edited — there is no variant status column. */}
          <Field label="Available for sale" hint={availability.reason}>
            <div
              className={cn(
                "flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-body",
                availability.tone,
              )}
            >
              {availability.label}
            </div>
          </Field>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          aria-controls={`vie-advanced-${variant.id}`}
          onClick={() => setAdvanced((v) => !v)}
          className="mt-4 -ml-2 text-caption text-muted-foreground"
        >
          {advanced ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
          {advanced ? "Hide extra settings" : "Show extra settings"}
        </Button>

        {advanced && (
          <div id={`vie-advanced-${variant.id}`} className="mt-5 space-y-6">
            {/* ── Pricing detail ───────────────────────────────────── */}
            <Section title="Pricing detail">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Compare at" htmlFor="vie-compare">
                  <Input
                    id="vie-compare"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="—"
                    value={draft.compareAtPrice}
                    onChange={(e) => onChange({ compareAtPrice: e.target.value })}
                    disabled={disabled}
                  />
                </Field>
                <Field label="Cost per item" htmlFor="vie-cost">
                  <Input
                    id="vie-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="—"
                    value={draft.cost}
                    onChange={(e) => onChange({ cost: e.target.value })}
                    disabled={disabled}
                  />
                </Field>
                <Field label="Margin">
                  <p className="flex h-9 items-center text-body tabular-nums text-muted-foreground">
                    {formatMargin(draft.price, draft.cost, currency)}
                  </p>
                </Field>
                <Field label="Barcode" htmlFor="vie-barcode">
                  <Input
                    id="vie-barcode"
                    className="font-mono"
                    placeholder="—"
                    value={draft.barcode}
                    onChange={(e) => onChange({ barcode: e.target.value })}
                    disabled={disabled}
                  />
                </Field>
              </div>
            </Section>

            {/* ── Where the stock sits ─────────────────────────────── */}
            <Section title="Where the stock sits">
              <div className="grid gap-4 lg:grid-cols-2">
                {warehousingEnabled ? (
                  <VariantWarehouseStockEditor
                    variantId={variant.id}
                    values={warehouseQty?.form ?? {}}
                    onChange={onWarehouseChange}
                    onLevelsLoaded={onLevelsLoaded}
                    disabled={disabled || !trackQuantity}
                  />
                ) : (
                  <div className="rounded-lg border border-border px-4 py-3 text-caption text-muted-foreground">
                    All stock for this variant sits in one place. Turn on warehousing
                    in{" "}
                    <Link to="/products/inventory" className="underline">
                      Inventory
                    </Link>{" "}
                    to split it across locations.
                  </div>
                )}

                <div className="space-y-3">
                  <SwitchRow
                    id="vie-track"
                    label="Track quantity"
                    hint={
                      trackForced
                        ? "Forced on for all products in Settings → Sync."
                        : "Stock drops with each order"
                    }
                    warn={trackForced}
                    checked={trackQuantity}
                    onCheckedChange={(v) => onChange({ trackQuantity: v })}
                    disabled={trackForced || disabled}
                  />
                  <SwitchRow
                    id="vie-continue"
                    label="Keep selling at zero"
                    hint={
                      oversellForced
                        ? "Forced on for all products in Settings → Sync."
                        : "Allow backorders"
                    }
                    warn={oversellForced}
                    checked={oversellForced ? true : draft.continueSelling}
                    onCheckedChange={(v) => onChange({ continueSelling: v })}
                    disabled={oversellForced || disabled}
                  />
                </div>
              </div>
            </Section>

            {/* ── Shipping and tax ─────────────────────────────────── */}
            <Section title="Shipping and tax">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Weight" htmlFor="vie-weight">
                  <div className="flex gap-2">
                    <Input
                      id="vie-weight"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.0"
                      value={draft.weight}
                      onChange={(e) => onChange({ weight: e.target.value })}
                      disabled={disabled || !draft.requiresShipping}
                    />
                    <Select
                      value={draft.weightUnit}
                      onValueChange={(v) => onChange({ weightUnit: v })}
                      disabled={disabled || !draft.requiresShipping}
                    >
                      <SelectTrigger className="w-20 shrink-0" aria-label="Weight unit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["g", "kg", "oz", "lb"].map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Field>

                <Field label="HS code" htmlFor="vie-hs">
                  <Input
                    id="vie-hs"
                    placeholder="6109.10"
                    className="font-mono"
                    value={draft.hsCode}
                    onChange={(e) => onChange({ hsCode: e.target.value })}
                    disabled={disabled}
                  />
                </Field>

                <Field label="GST rate">
                  <Select
                    value={draft.gstRate === "" ? INHERIT : draft.gstRate}
                    onValueChange={(v) => onChange({ gstRate: v === INHERIT ? "" : v })}
                    disabled={isVendor || disabled}
                  >
                    <SelectTrigger id="vie-gst-rate" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>
                        {productTax.gstRate
                          ? `${productTax.gstRate}% (product)`
                          : "Not set (product)"}
                      </SelectItem>
                      {GST_RATE_OPTIONS.map((rate) => (
                        <SelectItem key={rate} value={rate}>
                          {rate}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="HSN / SAC code" htmlFor="vie-hsn">
                  <Input
                    id="vie-hsn"
                    className="font-mono"
                    placeholder={
                      productTax.hsnCode
                        ? `${productTax.hsnCode} (product)`
                        : "Same as product"
                    }
                    value={draft.gstHsnCode}
                    onChange={(e) => onChange({ gstHsnCode: e.target.value })}
                    disabled={isVendor || disabled}
                  />
                </Field>

                <Field label="Country of origin" htmlFor="vie-country">
                  <Input
                    id="vie-country"
                    placeholder="IN"
                    maxLength={2}
                    className="font-mono uppercase"
                    value={draft.countryOfOrigin}
                    onChange={(e) =>
                      onChange({ countryOfOrigin: e.target.value.toUpperCase() })
                    }
                    disabled={disabled}
                  />
                </Field>

                <Field label="Unit (UQC)">
                  <Select
                    value={draft.uqc === "" ? INHERIT : draft.uqc}
                    onValueChange={(v) => onChange({ uqc: v === INHERIT ? "" : v })}
                    disabled={isVendor || disabled}
                  >
                    <SelectTrigger id="vie-uqc" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>
                        {`${productTax.unitOfMeasure || "NOS"} (product)`}
                      </SelectItem>
                      {COMMON_UQC.map((u) => (
                        <SelectItem key={u.code} value={u.code}>
                          {u.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Supply type">
                  <Select
                    value={draft.supplyType === "" ? INHERIT : draft.supplyType}
                    onValueChange={(v) =>
                      onChange({ supplyType: v === INHERIT ? "" : v })
                    }
                    disabled={isVendor || disabled}
                  >
                    <SelectTrigger id="vie-supply" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>
                        {`${
                          GST_SUPPLY_TYPES.find((t) => t.value === productTax.supplyType)
                            ?.label ?? productTax.supplyType
                        } (product)`}
                      </SelectItem>
                      {GST_SUPPLY_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <SwitchRow
                  id="vie-physical"
                  label="This is a physical product"
                  hint="Off for downloads and services"
                  checked={draft.requiresShipping}
                  onCheckedChange={(v) => onChange({ requiresShipping: v })}
                  disabled={disabled}
                />
                <SwitchRow
                  id="vie-taxable"
                  label="Charge tax"
                  hint="Include this variant in GST"
                  checked={draft.taxable}
                  onCheckedChange={(v) => onChange({ taxable: v })}
                  disabled={isVendor || disabled}
                />
              </div>

              <p className="mt-3 text-caption text-muted-foreground">
                {isVendor
                  ? "Tax fields are managed by the store owner."
                  : overrideSummary(draft)}
              </p>
            </Section>
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p
            className={cn(
              "text-caption",
              dirty ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {dirty ? `${summariseChanges(changes)} · saved with the page` : "No changes yet"}
          </p>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button type="button" variant="ghost" onClick={onRevert} disabled={disabled}>
                Revert
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-3 text-micro uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-label">
        {label}
      </Label>
      {children}
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  warn,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  warn?: boolean;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-label">
          {label}
        </Label>
        <p className={cn("text-micro", warn ? "text-warning" : "text-muted-foreground")}>
          {warn ? (
            <>
              Forced on for all products in{" "}
              <Link to="/settings" className="underline">
                Settings → Sync
              </Link>
              .
            </>
          ) : (
            hint
          )}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

function summariseChanges(changes: string[]): string {
  const unique = Array.from(new Set(changes));
  if (unique.length <= 2) {
    return `${unique.join(" and ")} changed`;
  }
  return `${unique.length} unsaved changes`;
}

/** Reads the live draft, not the saved variant — so it updates as you type. */
function overrideSummary(form: VariantDraft): string {
  const overridden = [
    form.gstHsnCode.trim() && "HSN/SAC",
    form.gstRate && "GST rate",
    form.uqc && "UQC",
    form.supplyType && "supply type",
  ].filter(Boolean) as string[];

  if (overridden.length === 0) {
    return "Tax, customs and GST follow the product. Nothing overridden here.";
  }
  return `Overrides the product on: ${overridden.join(", ")}.`;
}
