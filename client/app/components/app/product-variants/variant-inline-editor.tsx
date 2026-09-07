import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { inventoryKeys } from "~/hooks/use-inventory-queries";
import { useCreateAdjustmentMutation } from "~/hooks/use-inventory-mutations";
import { COMMON_UQC, GST_RATE_OPTIONS, GST_SUPPLY_TYPES } from "~/lib/gst-uqc";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { cn, formatMargin } from "~/lib/utils";
import {
  toGstRateOption,
  toInputNumber,
  toNullableNumber,
  type VariantDraft,
} from "~/lib/variant-draft";
import { formatVariantOptionLabel, type ProductTaxDefaults } from "~/lib/variant-grouping";
import type {
  GstSupplyType,
  ProductStatus,
  ProductVariant,
  UpdateVariantRequest,
} from "~/types/api";
import { VariantWarehouseStockEditor } from "./variant-warehouse-stock-editor";

/** Radix Select reserves "" for "nothing selected", so inherit needs a sentinel. */
const INHERIT = "__inherit";

type VariantEditDraft = {
  price: string;
  compareAtPrice: string;
  cost: string;
  sku: string;
  barcode: string;
  /** Legacy single-number stock. Unused (and unsent) once warehousing is on. */
  inventoryQuantity: string;
  trackQuantity: boolean;
  continueSelling: boolean;
  taxable: boolean;
  requiresShipping: boolean;
  weight: string;
  weightUnit: string;
  hsCode: string;
  countryOfOrigin: string;
  // GST override — "" everywhere means "inherit from the product".
  gstHsnCode: string;
  gstRate: string;
  uqc: string;
  supplyType: string;
  /** warehouseId → desired AVAILABLE. Seeded once the stock query resolves. */
  warehouseQty: Record<string, string>;
};

function seedDraft(
  variant: ProductVariant,
  draft: VariantDraft | undefined,
): VariantEditDraft {
  return {
    // Table drafts win: a price typed into the row and not yet saved must not
    // be silently reverted by opening the panel on that same row.
    price: draft?.price ?? toInputNumber(variant.price),
    compareAtPrice: toInputNumber(variant.compareAtPrice),
    cost: draft?.cost ?? toInputNumber(variant.cost),
    sku: draft?.sku ?? variant.sku ?? "",
    barcode: variant.barcode ?? "",
    inventoryQuantity:
      draft?.inventoryQuantity ?? toInputNumber(variant.inventoryQuantity ?? 0),
    trackQuantity: variant.trackQuantity ?? true,
    continueSelling: variant.continueSellingWhenOutOfStock ?? false,
    taxable: variant.taxable ?? true,
    requiresShipping: variant.requiresShipping ?? true,
    weight: toInputNumber(variant.weight),
    weightUnit: variant.weightUnit ?? "kg",
    hsCode: variant.hsCode ?? "",
    countryOfOrigin: variant.countryOfOrigin ?? "",
    gstHsnCode: variant.hsnCode ?? "",
    gstRate: toGstRateOption(variant.gstRate),
    uqc: variant.unitOfMeasure ?? "",
    supplyType: variant.supplyType ?? "",
    warehouseQty: {},
  };
}

const FIELD_LABELS: Partial<Record<keyof VariantEditDraft, string>> = {
  price: "price",
  compareAtPrice: "compare-at",
  cost: "cost",
  sku: "SKU",
  barcode: "barcode",
  inventoryQuantity: "stock",
  trackQuantity: "track quantity",
  continueSelling: "keep selling at zero",
  taxable: "charge tax",
  requiresShipping: "shipping",
  weight: "weight",
  weightUnit: "weight unit",
  hsCode: "HS code",
  countryOfOrigin: "country of origin",
  gstHsnCode: "HSN/SAC",
  gstRate: "GST rate",
  uqc: "UQC",
  supplyType: "supply type",
};

function changedLabels(base: VariantEditDraft, form: VariantEditDraft): string[] {
  const labels: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as Array<keyof VariantEditDraft>) {
    if (base[key] !== form[key]) labels.push(FIELD_LABELS[key]!);
  }
  const warehouses = Object.keys({ ...base.warehouseQty, ...form.warehouseQty });
  if (warehouses.some((id) => base.warehouseQty[id] !== form.warehouseQty[id])) {
    labels.push("stock");
  }
  return labels;
}

function buildPatch(
  base: VariantEditDraft,
  form: VariantEditDraft,
  { isVendor, warehousingEnabled }: { isVendor: boolean; warehousingEnabled: boolean },
): UpdateVariantRequest {
  const data: UpdateVariantRequest = {};

  if (form.price !== base.price) {
    const n = Number(form.price);
    if (form.price.trim() && Number.isFinite(n)) data.price = n;
  }
  if (form.compareAtPrice !== base.compareAtPrice) {
    const n = toNullableNumber(form.compareAtPrice);
    if (n !== undefined) data.compareAtPrice = n;
  }
  if (form.cost !== base.cost) {
    const n = toNullableNumber(form.cost);
    if (n !== undefined) data.cost = n;
  }
  if (form.sku !== base.sku) data.sku = form.sku.trim() || null;
  if (form.barcode !== base.barcode) data.barcode = form.barcode.trim() || null;
  // Under warehousing the quantity belongs to a warehouse, and the server
  // rejects it here without one — those go out as adjustments instead.
  if (!warehousingEnabled && form.inventoryQuantity !== base.inventoryQuantity) {
    const n = Number.parseInt(form.inventoryQuantity, 10);
    if (Number.isFinite(n)) data.inventoryQuantity = n;
  }
  if (form.trackQuantity !== base.trackQuantity) {
    data.trackQuantity = form.trackQuantity;
  }
  if (form.continueSelling !== base.continueSelling) {
    data.continueSellingWhenOutOfStock = form.continueSelling;
  }
  if (form.taxable !== base.taxable) data.taxable = form.taxable;
  if (form.requiresShipping !== base.requiresShipping) {
    data.requiresShipping = form.requiresShipping;
  }
  if (form.weight !== base.weight) {
    const n = toNullableNumber(form.weight);
    if (n !== undefined) data.weight = n;
  }
  // A unit with no weight is meaningless to the server, so it only travels
  // alongside one.
  if (form.weightUnit !== base.weightUnit && form.weight.trim()) {
    data.weightUnit = form.weightUnit as UpdateVariantRequest["weightUnit"];
  }
  if (form.hsCode !== base.hsCode) data.hsCode = form.hsCode.trim() || null;
  if (form.countryOfOrigin !== base.countryOfOrigin) {
    data.countryOfOrigin = form.countryOfOrigin.trim().toUpperCase() || null;
  }
  if (!isVendor) {
    // null = back to inheriting from the product.
    if (form.gstHsnCode !== base.gstHsnCode) {
      data.hsnCode = form.gstHsnCode.trim() || null;
    }
    if (form.gstRate !== base.gstRate) {
      data.gstRate = form.gstRate === "" ? null : Number(form.gstRate);
    }
    if (form.uqc !== base.uqc) data.unitOfMeasure = form.uqc || null;
    if (form.supplyType !== base.supplyType) {
      data.supplyType =
        form.supplyType === "" ? null : (form.supplyType as GstSupplyType);
    }
  }
  return data;
}

/**
 * Whether this variant is actually purchasable, and why.
 *
 * There is no per-variant status column — sellability falls out of the product
 * status, the two inventory switches and the stock on hand. So this reports
 * rather than edits: a dropdown here would be a control with nowhere to write,
 * and a second, conflicting UI for the two switches below.
 */
function deriveAvailability(
  form: VariantEditDraft,
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
 * Mount it with `key={variant.id}` — the draft is seeded by lazy initialiser
 * rather than an effect, so a background refetch can never re-seed over what
 * the merchant is typing.
 */
export function VariantInlineEditor({
  variant,
  draft,
  productTax,
  productStatus,
  currency,
  colSpan,
  warehousingEnabled,
  trackForced,
  oversellForced,
  isVendor,
  isSaving,
  onSaveVariant,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  variant: ProductVariant;
  draft: VariantDraft | undefined;
  productTax: ProductTaxDefaults;
  productStatus: ProductStatus;
  currency: string;
  colSpan: number;
  warehousingEnabled: boolean;
  trackForced: boolean;
  oversellForced: boolean;
  isVendor: boolean;
  isSaving: boolean;
  onSaveVariant: (variantId: string, data: UpdateVariantRequest) => Promise<void>;
  /** Fires only after every call in the save sequence has resolved. */
  onSaved: (patch: Partial<VariantDraft>) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(() => seedDraft(variant, draft));
  const [form, setForm] = useState(baseline);
  const [advanced, setAdvanced] = useState(true);
  const [stockReloadKey, setStockReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const queryClient = useQueryClient();
  const adjust = useCreateAdjustmentMutation({ silent: true });

  const changes = changedLabels(baseline, form);
  const dirty = changes.length > 0;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const set = <K extends keyof VariantEditDraft>(key: K, value: VariantEditDraft[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Both halves move together so a warehouse can never look "changed" merely
  // because the baseline arrived a render later than the form.
  const seedWarehouses = useCallback((seed: Record<string, string>) => {
    setBaseline((prev) => ({ ...prev, warehouseQty: seed }));
    setForm((prev) => ({ ...prev, warehouseQty: { ...seed, ...prev.warehouseQty } }));
  }, []);

  const trackQuantity = trackForced ? true : form.trackQuantity;
  const optionLabel = formatVariantOptionLabel(variant) ?? variant.title;
  const saving = busy || isSaving;

  const shownStock = warehousingEnabled
    ? (variant.inventoryQuantity ?? 0)
    : Number.parseInt(form.inventoryQuantity, 10) || 0;
  const availability = deriveAvailability(form, productStatus, shownStock);

  async function handleSave() {
    if (!dirty || saving) return;
    setBusy(true);
    try {
      const data = buildPatch(baseline, form, { isVendor, warehousingEnabled });
      if (Object.keys(data).length > 0) {
        await onSaveVariant(variant.id, data);
      }

      if (warehousingEnabled) {
        const changed = Object.keys(form.warehouseQty).filter(
          (id) => form.warehouseQty[id] !== baseline.warehouseQty[id],
        );
        // Sequential on purpose: each movement recomputes the variant's
        // sellable cache, so parallel writes to one variant race each other.
        for (const warehouseId of changed) {
          const setTo = Number.parseInt(form.warehouseQty[warehouseId], 10);
          if (!Number.isInteger(setTo) || setTo < 0) continue;
          await adjust.mutateAsync({
            variantId: variant.id,
            warehouseId,
            bucket: "AVAILABLE",
            setTo,
            reason: "correction",
            note: "Edited from product variants",
          });
        }
      }

      onSaved({
        price: form.price,
        cost: form.cost,
        sku: form.sku,
        ...(warehousingEnabled ? {} : { inventoryQuantity: form.inventoryQuantity }),
      });
      onCancel();
    } catch (error) {
      // Adjustments already applied stay applied — there is no undo endpoint,
      // and a compensating adjustment would write a ledger row that never
      // happened. Show the server's own reason and re-seed from what is now
      // true, so the inputs stop showing an intent that didn't land.
      handleMutationError(error, "Couldn't save this variant.");
      await queryClient.invalidateQueries({
        queryKey: inventoryKeys.variantStock(variant.id),
      });
      if (warehousingEnabled) {
        setForm((prev) => ({ ...prev, warehouseQty: {} }));
        setBaseline((prev) => ({ ...prev, warehouseQty: {} }));
        setStockReloadKey((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

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
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              disabled={saving}
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
                  : form.inventoryQuantity
              }
              onChange={(e) => set("inventoryQuantity", e.target.value)}
              disabled={saving || warehousingEnabled || !trackQuantity}
            />
          </Field>

          <Field label="SKU" htmlFor="vie-sku">
            <Input
              id="vie-sku"
              value={form.sku}
              placeholder="Add a SKU"
              aria-invalid={!form.sku.trim() || undefined}
              className="font-mono"
              onChange={(e) => set("sku", e.target.value)}
              disabled={saving}
            />
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
                    value={form.compareAtPrice}
                    onChange={(e) => set("compareAtPrice", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="Cost per item" htmlFor="vie-cost">
                  <Input
                    id="vie-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="—"
                    value={form.cost}
                    onChange={(e) => set("cost", e.target.value)}
                    disabled={saving}
                  />
                </Field>
                <Field label="Margin">
                  <p className="flex h-9 items-center text-body tabular-nums text-muted-foreground">
                    {form.cost.trim()
                      ? formatMargin(form.price, form.cost, currency)
                      : "Set cost to see"}
                  </p>
                </Field>
                <Field label="Barcode" htmlFor="vie-barcode">
                  <Input
                    id="vie-barcode"
                    className="font-mono"
                    placeholder="—"
                    value={form.barcode}
                    onChange={(e) => set("barcode", e.target.value)}
                    disabled={saving}
                  />
                </Field>
              </div>
            </Section>

            {/* ── Where the stock sits ─────────────────────────────── */}
            <Section title="Where the stock sits">
              <div className="grid gap-4 lg:grid-cols-2">
                {warehousingEnabled ? (
                  <VariantWarehouseStockEditor
                    key={stockReloadKey}
                    variantId={variant.id}
                    values={form.warehouseQty}
                    onChange={(warehouseId, value) =>
                      setForm((prev) => ({
                        ...prev,
                        warehouseQty: { ...prev.warehouseQty, [warehouseId]: value },
                      }))
                    }
                    onLevelsLoaded={seedWarehouses}
                    disabled={saving || !trackQuantity}
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
                    onCheckedChange={(v) => set("trackQuantity", v)}
                    disabled={trackForced || saving}
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
                    checked={oversellForced ? true : form.continueSelling}
                    onCheckedChange={(v) => set("continueSelling", v)}
                    disabled={oversellForced || saving}
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
                      value={form.weight}
                      onChange={(e) => set("weight", e.target.value)}
                      disabled={saving || !form.requiresShipping}
                    />
                    <Select
                      value={form.weightUnit}
                      onValueChange={(v) => set("weightUnit", v)}
                      disabled={saving || !form.requiresShipping}
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
                    value={form.hsCode}
                    onChange={(e) => set("hsCode", e.target.value)}
                    disabled={saving}
                  />
                </Field>

                <Field label="GST rate">
                  <Select
                    value={form.gstRate === "" ? INHERIT : form.gstRate}
                    onValueChange={(v) => set("gstRate", v === INHERIT ? "" : v)}
                    disabled={isVendor || saving}
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
                    value={form.gstHsnCode}
                    onChange={(e) => set("gstHsnCode", e.target.value)}
                    disabled={isVendor || saving}
                  />
                </Field>

                <Field label="Country of origin" htmlFor="vie-country">
                  <Input
                    id="vie-country"
                    placeholder="IN"
                    maxLength={2}
                    className="font-mono uppercase"
                    value={form.countryOfOrigin}
                    onChange={(e) => set("countryOfOrigin", e.target.value.toUpperCase())}
                    disabled={saving}
                  />
                </Field>

                <Field label="Unit (UQC)">
                  <Select
                    value={form.uqc === "" ? INHERIT : form.uqc}
                    onValueChange={(v) => set("uqc", v === INHERIT ? "" : v)}
                    disabled={isVendor || saving}
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
                    value={form.supplyType === "" ? INHERIT : form.supplyType}
                    onValueChange={(v) => set("supplyType", v === INHERIT ? "" : v)}
                    disabled={isVendor || saving}
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
                  checked={form.requiresShipping}
                  onCheckedChange={(v) => set("requiresShipping", v)}
                  disabled={saving}
                />
                <SwitchRow
                  id="vie-taxable"
                  label="Charge tax"
                  hint="Include this variant in GST"
                  checked={form.taxable}
                  onCheckedChange={(v) => set("taxable", v)}
                  disabled={isVendor || saving}
                />
              </div>

              <p className="mt-3 text-caption text-muted-foreground">
                {isVendor
                  ? "Tax fields are managed by the store owner."
                  : overrideSummary(form)}
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
            {dirty ? summariseChanges(changes) : "No changes yet"}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              onClick={handleSave}
              // Deliberately NOT gated on the warehouse levels having loaded.
              // The editor lives inside the collapsible section, so a "wait for
              // stock" gate left Save dead for anyone who only wanted to change
              // a price. It is safe: warehouse quantities can only be typed into
              // inputs that exist once the levels are in, and until then both
              // halves of the diff are empty, so the adjustment loop is a no-op.
              disabled={!dirty || saving}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save variant
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

/** Reads the live form, not the saved variant — so it updates as you type. */
function overrideSummary(form: VariantEditDraft): string {
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
