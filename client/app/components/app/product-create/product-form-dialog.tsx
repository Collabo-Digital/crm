import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight, X, Loader2, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useInventoryStatus } from "~/hooks/use-inventory-queries";
import { formatMargin } from "~/lib/utils";
import { normalizeProductOptions } from "~/lib/product-options";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { RichTextEditor } from "~/components/ui/rich-text-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  useBulkUpdateVariantsMutation,
  useCreateProductMutation,
  useDeleteVariantMutation,
  useGenerateVariantsMutation,
  useUpdateOptionsMutation,
  useUpdateProductMutation,
} from "~/hooks/use-product-mutations";
import { useProduct } from "~/hooks/use-product-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import type {
  CreateProductRequest,
  GstSupplyType,
  ProductDetail,
  ProductOption,
  ProductStatus,
  ProductVariant,
  ProductVariantInput,
  UpdateProductRequest,
  UpdateVariantRequest,
} from "~/types/api";
import { COMMON_UQC, GST_RATE_OPTIONS, GST_SUPPLY_TYPES } from "~/lib/gst-uqc";

/**
 * `<input type="datetime-local">` speaks LOCAL wall-clock time with no zone.
 * Hydrating it from `toISOString().slice(0, 16)` fed it UTC, so every save
 * shifted the schedule by the timezone offset (IST: 18:30Z rendered as 18:30,
 * saved back as 13:00Z). Format with local getters instead; `new Date(local)`
 * parses the same string back as local, so submit is just toISOString().
 */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function optionsEqual(a: ProductOption[] | null | undefined, b: ProductOption[] | null | undefined): boolean {
  return (
    JSON.stringify(normalizeProductOptions(a ?? [])) ===
    JSON.stringify(normalizeProductOptions(b ?? []))
  );
}
import { OptionsEditor } from "./options-editor";
import { VariantEditor } from "./variant-editor";
import { ImageGalleryUploader } from "./image-gallery-uploader";
import { CODE_TERMS } from "~/lib/inventory-vocabulary";

// Feature flag — media uploads are temporarily held while we finalize storage
// strategy (local disk vs S3). The backend endpoints (POST /products/:id/images,
// PATCH /products/images/:id, etc.) are still wired up; only the UI entry
// points are hidden. Flip to `true` to re-enable.
const MEDIA_UPLOAD_ENABLED = false;

type WeightUnit = "g" | "kg" | "oz" | "lb";

type FormState = {
  title: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tagsCsv: string;
  bodyHtml: string;
  hsnCode: string;
  gstRate: string; // string in form, parsed to number on submit
  unitOfMeasure: string; // GST UQC; "" = server default (NOS)
  supplyType: GstSupplyType;
  /** ISO 8601 datetime-local string for the scheduled publish picker. */
  publishedAt: string;
  // Single-variant flow (toggle OFF). Mirrors the multi-variant detail panel
  // so single-variant products get the same Phase 2 fields (cost, customs,
  // inventory toggles, shipping settings, tax).
  variant: {
    price: string;
    sku: string;
    compareAtPrice: string;
    inventoryQuantity: string;
    cost: string;
    barcode: string;
    weight: string;
    weightUnit: WeightUnit;
    hsCode: string;
    countryOfOrigin: string;
    trackQuantity: boolean;
    continueSellingWhenOutOfStock: boolean;
    requiresShipping: boolean;
    taxable: boolean;
  };
  // Multi-variant flow (toggle ON)
  hasOptions: boolean;
  options: ProductOption[];
  variants: ProductVariantInput[];
};

const EMPTY: FormState = {
  title: "",
  vendor: "",
  productType: "",
  status: "ACTIVE",
  tagsCsv: "",
  bodyHtml: "",
  hsnCode: "",
  gstRate: "",
  unitOfMeasure: "",
  supplyType: "TAXABLE",
  publishedAt: "",
  variant: {
    price: "",
    sku: "",
    compareAtPrice: "",
    inventoryQuantity: "0",
    cost: "",
    barcode: "",
    weight: "",
    weightUnit: "kg",
    hsCode: "",
    countryOfOrigin: "",
    trackQuantity: true,
    continueSellingWhenOutOfStock: false,
    requiresShipping: true,
    taxable: true,
  },
  hasOptions: false,
  options: [],
  variants: [],
};

function fromProduct(p: ProductDetail): FormState {
  const v = p.variants[0];
  const isMulti = !!p.options && p.options.length > 0;
  return {
    title: p.title,
    vendor: p.vendor ?? "",
    productType: p.productType ?? "",
    status: p.status,
    tagsCsv: (p.tags ?? []).join(", "),
    bodyHtml: p.bodyHtml ?? "",
    hsnCode: p.hsnCode ?? "",
    gstRate: p.gstRate != null ? String(Number(p.gstRate)) : "",
    unitOfMeasure: p.unitOfMeasure ?? "",
    supplyType: p.supplyType ?? "TAXABLE",
    publishedAt: p.publishedAt ? toDatetimeLocal(p.publishedAt) : "",
    variant: {
      price: v ? String(v.price) : "",
      sku: v?.sku ?? "",
      compareAtPrice: v?.compareAtPrice ? String(v.compareAtPrice) : "",
      inventoryQuantity: v ? String(v.inventoryQuantity) : "0",
      cost: v?.cost != null ? String(v.cost) : "",
      barcode: v?.barcode ?? "",
      weight: v?.weight != null ? String(v.weight) : "",
      weightUnit: (v?.weightUnit as WeightUnit | null) ?? "kg",
      hsCode: v?.hsCode ?? "",
      countryOfOrigin: v?.countryOfOrigin ?? "",
      trackQuantity: v?.trackQuantity ?? true,
      continueSellingWhenOutOfStock: v?.continueSellingWhenOutOfStock ?? false,
      requiresShipping: v?.requiresShipping ?? true,
      taxable: v?.taxable ?? true,
    },
    hasOptions: isMulti,
    options: normalizeProductOptions(p.options ?? []),
    variants: p.variants.map((vv) => ({
      id: vv.id,
      price: Number(vv.price),
      sku: vv.sku ?? undefined,
      barcode: vv.barcode ?? undefined,
      compareAtPrice: vv.compareAtPrice ?? undefined,
      cost: vv.cost != null ? Number(vv.cost) : undefined,
      inventoryQuantity: vv.inventoryQuantity,
      trackQuantity: vv.trackQuantity ?? true,
      continueSellingWhenOutOfStock: vv.continueSellingWhenOutOfStock ?? false,
      weight: vv.weight != null ? Number(vv.weight) : undefined,
      weightUnit: vv.weightUnit ?? undefined,
      hsCode: vv.hsCode ?? undefined,
      countryOfOrigin: vv.countryOfOrigin ?? undefined,
      requiresShipping: vv.requiresShipping ?? true,
      taxable: vv.taxable ?? true,
      hsnCode: vv.hsnCode ?? undefined,
      gstRate: vv.gstRate != null ? Number(vv.gstRate) : undefined,
      unitOfMeasure: vv.unitOfMeasure ?? undefined,
      supplyType: vv.supplyType ?? undefined,
      option1: vv.option1 ?? undefined,
      option2: vv.option2 ?? undefined,
      option3: vv.option3 ?? undefined,
      position: vv.position,
      imageId: vv.imageId ?? undefined,
    })),
  };
}

/**
 * Cartesian product of all option values → variant rows.
 * Used as a one-shot generator in the form's create flow.
 */
function generateVariantsLocally(options: ProductOption[]): ProductVariantInput[] {
  if (options.length === 0) return [];
  const valuesAt = (i: number) => options[i]?.values ?? [];
  const out: ProductVariantInput[] = [];
  let pos = 1;
  const v1 = valuesAt(0);
  const v2 = options.length >= 2 ? valuesAt(1) : [null];
  const v3 = options.length >= 3 ? valuesAt(2) : [null];
  for (const a of v1) {
    for (const b of v2) {
      for (const c of v3) {
        out.push({
          price: 0,
          option1: a as string,
          option2: (b as string) ?? undefined,
          option3: (c as string) ?? undefined,
          position: pos++,
          inventoryQuantity: 0,
        });
      }
    }
  }
  return out;
}

/**
 * Create / edit dialog for CRM-native products. Pass `productId` to edit;
 * omit it for create mode. Internally fetches the full product detail via
 * `useProduct` so the parent doesn't have to. Caller is expected to only
 * open this for MANUAL-channel products in edit mode (server returns 403
 * for SHOPIFY ones anyway).
 */
export function ProductFormDialog({
  productId,
  onClose,
}: {
  productId?: string;
  onClose: () => void;
}) {
  const isEdit = !!productId;
  // Vendors may edit product details but not the vendor assignment or tax
  // fields — those render read-only (backend also enforces this).
  const { isVendor } = useCurrentRole();
  const { data: product, isLoading, refetch } = useProduct(productId ?? null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Warehousing orgs keep stock per warehouse; the variant column is a cache
  // the ledger recomputes, so the dialog must neither offer nor send it.
  const warehousingEnabled = useInventoryStatus().data?.warehousingEnabled === true;

  // Hydrate ONCE per opened product. This used to run on every new `product`
  // object, and react-query hands out a new object on every refetch — the
  // generate button invalidates the detail query, and useProduct polls every
  // 3s while a Shopify push is PENDING — so typed values were wiped mid-edit,
  // which reads exactly like "the field didn't save".
  const hydratedIdRef = useRef<string | null>(null);
  // Server state the diffs are computed against; refreshed after any
  // structural change (generate / failed save) so a second Save is correct.
  const baseProductRef = useRef<ProductDetail | null>(null);
  useEffect(() => {
    if (!productId) {
      hydratedIdRef.current = null;
      baseProductRef.current = null;
      return;
    }
    if (!product || hydratedIdRef.current === product.id) return;
    hydratedIdRef.current = product.id;
    baseProductRef.current = product;
    setForm(fromProduct(product));
    setErrors({});
  }, [product, productId]);

  /** Replace only the structural part of the form with fresh server state. */
  function applyFreshVariants(fresh: ProductDetail) {
    baseProductRef.current = fresh;
    const f = fromProduct(fresh);
    setForm((prev) => ({
      ...prev,
      hasOptions: prev.hasOptions || f.hasOptions,
      options: f.options,
      variants: f.variants,
    }));
  }

  // Every step of an edit is awaited in sequence below and reported once;
  // the hooks stay silent so a 12-variant save is one toast, not thirteen.
  const createMutation = useCreateProductMutation();
  const updateMutation = useUpdateProductMutation({ silent: true });
  const updateOptionsMutation = useUpdateOptionsMutation(productId ?? "", { silent: true });
  const generateVariantsMutation = useGenerateVariantsMutation(productId ?? "", { silent: true });
  const bulkUpdateVariantsMutation = useBulkUpdateVariantsMutation(productId ?? "", { silent: true });
  const deleteVariantMutation = useDeleteVariantMutation(productId ?? "", { silent: true });
  const [saving, setSaving] = useState(false);
  const isPending = createMutation.isPending || saving;

  function patch(p: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  function patchVariant(p: Partial<FormState["variant"]>) {
    setForm((prev) => ({ ...prev, variant: { ...prev.variant, ...p } }));
  }

  function regenerateVariantsClient() {
    patch({ variants: generateVariantsLocally(form.options) });
  }

  function optionsError(): string | null {
    if (form.options.length === 0) return "Add at least one option type";
    if (form.options.some((o) => !o.name.trim())) return "Every option needs a name";
    if (form.options.some((o) => o.values.length === 0)) return "Every option needs at least one value";
    return null;
  }

  /**
   * Edit mode: persist the option types FIRST, then let the server generate
   * the missing combinations (it fills new slots on existing variants with
   * the first value, same as Shopify), then pull the resulting rows into the
   * form without touching anything else the user has typed. This used to call
   * generate against the options already stored on the server, so a freshly
   * typed option produced "Product has no options defined" or "Generated 0".
   */
  async function handleGenerateInEdit() {
    const err = optionsError();
    if (err) {
      setErrors((prev) => ({ ...prev, options: err }));
      return;
    }
    setSaving(true);
    try {
      await updateOptionsMutation.mutateAsync(normalizeProductOptions(form.options));
      const result = await generateVariantsMutation.mutateAsync();
      const { data: fresh } = await refetch();
      if (fresh) applyFreshVariants(fresh);
      setErrors((prev) => ({ ...prev, options: "", variants: "" }));
      toast.success(
        `Added ${result.created} new variant${result.created === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      handleMutationError(e, "Failed to generate variants.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Edit save, in the only order that keeps the server consistent:
   *   1. product fields (+ the single default variant when no options)
   *   2. collapsing to single-variant: drop rows 2..n, then clear options
   *      (the server refuses to clear options while >1 variant exists)
   *   3. multi-variant: rows the user removed → options (+ generate when they
   *      changed) → one bulk field update for the rows that remain
   * Any failure stops the sequence, keeps the dialog open with one error
   * toast, and re-syncs the structural part of the form from the server.
   */
  async function runEditSave(tags: string[]) {
    if (!productId) return;
    const base = baseProductRef.current ?? product;
    if (!base) return;
    setSaving(true);
    try {
      const data: UpdateProductRequest = {
        title: form.title.trim(),
        // Empty strings are sent on purpose: `undefined` meant "leave as is",
        // so a cleared Vendor / Product type / HSN came straight back.
        vendor: form.vendor.trim(),
        productType: form.productType.trim(),
        bodyHtml: form.bodyHtml,
        status: form.status,
        tags,
        hsnCode: form.hsnCode.trim(),
        gstRate: form.gstRate ? Number(form.gstRate) : null,
        unitOfMeasure: form.unitOfMeasure,
        supplyType: form.supplyType,
        publishedAt:
          form.status === "DRAFT" && form.publishedAt
            ? new Date(form.publishedAt).toISOString()
            : null,
      };
      if (!form.hasOptions) {
        const v = buildSingleVariantPayload(form.variant);
        if (warehousingEnabled) delete v.inventoryQuantity;
        data.variant = v;
      }
      await updateMutation.mutateAsync({ id: productId, data });

      const hadOptions = (base.options?.length ?? 0) > 0;
      if (hadOptions && !form.hasOptions) {
        const [, ...extra] = base.variants;
        for (const v of extra) await deleteVariantMutation.mutateAsync(v.id);
        await updateOptionsMutation.mutateAsync([]);
      }

      if (form.hasOptions) {
        const keptIds = new Set(form.variants.map((v) => v.id).filter(Boolean));
        for (const v of base.variants) {
          if (!keptIds.has(v.id)) await deleteVariantMutation.mutateAsync(v.id);
        }

        const normalized = normalizeProductOptions(form.options);
        const optionsChanged = !optionsEqual(normalized, base.options);
        if (optionsChanged) {
          await updateOptionsMutation.mutateAsync(normalized);
          await generateVariantsMutation.mutateAsync();
        }

        const originalById = new Map(base.variants.map((v) => [v.id, v]));
        const updates: Array<UpdateVariantRequest & { variantId: string }> = [];
        for (const v of form.variants) {
          if (!v.id) continue;
          const orig = originalById.get(v.id);
          if (!orig) continue;
          const diff = diffVariant(orig, v);
          if (optionsChanged) {
            // The server just remapped slots and positions; the form's copies
            // predate that and must not overwrite it.
            delete diff.option1;
            delete diff.option2;
            delete diff.option3;
            delete diff.position;
          }
          if (warehousingEnabled) delete diff.inventoryQuantity;
          if (Object.keys(diff).length > 0) {
            updates.push({ variantId: v.id, ...(diff as UpdateVariantRequest) });
          }
        }
        if (updates.length > 0) await bulkUpdateVariantsMutation.mutateAsync(updates);
      }

      toast.success("Product updated.");
      onClose();
    } catch (e) {
      handleMutationError(e, "Failed to save product.");
      const { data: fresh } = await refetch();
      if (fresh) applyFreshVariants(fresh);
    } finally {
      setSaving(false);
    }
  }

  function handleToggleOptions(checked: boolean) {
    if (checked && !form.hasOptions) {
      // Switching ON: seed with one empty option type so the UI has something.
      patch({
        hasOptions: true,
        options:
          form.options.length > 0
            ? form.options
            : [{ name: "", values: [], position: 1 }],
        variants: form.variants.length > 0 ? form.variants : [],
      });
    } else if (!checked && form.hasOptions) {
      // Switching OFF: drop options/variants — single-variant fields take over.
      patch({ hasOptions: false, options: [], variants: [] });
    }
  }

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!form.title.trim()) e.title = "Title is required";

    if (form.hasOptions) {
      if (form.options.length === 0) e.options = "Add at least one option type";
      const namelessOptionIdx = form.options.findIndex((o) => !o.name.trim());
      if (namelessOptionIdx >= 0) e.options = "Every option needs a name";
      const emptyValuesIdx = form.options.findIndex((o) => o.values.length === 0);
      if (emptyValuesIdx >= 0) e.options = "Every option needs at least one value";
      if (form.variants.length === 0) e.variants = "Add variants from your options";
      const badPriceIdx = form.variants.findIndex((v) => v.price === undefined || v.price < 0);
      if (badPriceIdx >= 0) e.variants = `Variant ${badPriceIdx + 1} needs a non-negative price`;
    } else {
      if (!form.variant.price || isNaN(parseFloat(form.variant.price))) {
        e.price = "Price is required";
      } else if (parseFloat(form.variant.price) < 0) {
        e.price = "Price must be ≥ 0";
      }
    }

    if (form.gstRate && (parseFloat(form.gstRate) < 0 || parseFloat(form.gstRate) > 28)) {
      e.gstRate = "GST rate must be 0–28";
    }
    return e;
  }

  function handleSubmit() {
    const e = validate();
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return;
    }

    const tags = form.tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (isEdit && productId) {
      void runEditSave(tags);
      return;
    }

    // CREATE MODE — single OR multi.
    const baseCreate = {
      title: form.title,
      vendor: form.vendor || undefined,
      productType: form.productType || undefined,
      status: form.status,
      tags,
      bodyHtml: form.bodyHtml || undefined,
      hsnCode: form.hsnCode || undefined,
      gstRate: form.gstRate ? parseFloat(form.gstRate) : undefined,
      unitOfMeasure: form.unitOfMeasure || undefined,
      supplyType: form.supplyType,
      publishedAt:
        form.status === "DRAFT" && form.publishedAt
          ? new Date(form.publishedAt).toISOString()
          : undefined,
    };

    const data: CreateProductRequest = form.hasOptions
      ? {
          ...baseCreate,
          options: form.options,
          variants: form.variants.map((v) => ({
            price: v.price,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
            compareAtPrice: v.compareAtPrice ?? undefined,
            cost: v.cost ?? undefined,
            // Warehousing orgs seed stock per warehouse, never via this column.
            inventoryQuantity: warehousingEnabled ? undefined : (v.inventoryQuantity ?? 0),
            trackQuantity: v.trackQuantity,
            continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
            weight: v.weight ?? undefined,
            weightUnit: v.weight != null ? (v.weightUnit ?? "kg") : undefined,
            hsCode: v.hsCode || undefined,
            countryOfOrigin: v.countryOfOrigin || undefined,
            requiresShipping: v.requiresShipping,
            taxable: v.taxable,
            // Per-variant GST override — the panel offers these on create too;
            // they were silently dropped from this payload.
            hsnCode: v.hsnCode || undefined,
            gstRate: v.gstRate ?? undefined,
            unitOfMeasure: v.unitOfMeasure || undefined,
            supplyType: v.supplyType ?? undefined,
            option1: v.option1 || undefined,
            option2: v.option2 || undefined,
            option3: v.option3 || undefined,
            position: v.position,
          })),
        }
      : {
          ...baseCreate,
          variant: (() => {
            const single = buildSingleVariantPayload(form.variant);
            if (warehousingEnabled) delete single.inventoryQuantity;
            return single;
          })(),
        };
    createMutation.mutate(data, { onSuccess: () => onClose() });
  }

  const wideMode = form.hasOptions; // expand dialog when the variant table is shown

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${wideMode ? "max-w-4xl" : "max-w-2xl"} max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {isEdit ? "Edit product" : "Create product"}
            </h2>
            <p className="text-[10px] text-muted-foreground">
              {isEdit
                ? "Update name, price, tax, or stock for this CRM-managed product."
                : "Add a product to your CRM. It can be used in offline orders right away, and syncs to Shopify when you connect a store."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        {isEdit && isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">
            {/* Section: product */}
            <Section title="Product">
              <Field
                label="Title"
                required
                error={errors.title}
                value={form.title}
                onChange={(v) => patch({ title: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Vendor"
                  value={form.vendor}
                  onChange={(v) => patch({ vendor: v })}
                  disabled={isVendor}
                />
                <Field
                  label="Product type"
                  value={form.productType}
                  onChange={(v) => patch({ productType: v })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    Status
                  </span>
                  <Select
                    value={form.status}
                    onValueChange={(v) =>
                      patch({ status: v as ProductStatus })
                    }
                  >
                    <SelectTrigger className="mt-1 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE" className="text-xs">Active</SelectItem>
                      <SelectItem value="DRAFT" className="text-xs">Draft</SelectItem>
                      <SelectItem value="ARCHIVED" className="text-xs">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <Field
                  label="Tags (comma-separated)"
                  value={form.tagsCsv}
                  onChange={(v) => patch({ tagsCsv: v })}
                  placeholder="summer, sale"
                />
              </div>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  Description
                </span>
                <div className="mt-1">
                  <RichTextEditor
                    key={productId ?? "new"}
                    value={form.bodyHtml}
                    onChange={(v) => patch({ bodyHtml: v })}
                    placeholder="Describe this product…"
                  />
                </div>
              </label>
              {form.status === "DRAFT" && (
                <Field
                  label="Schedule publish (optional)"
                  type="datetime-local"
                  value={form.publishedAt}
                  onChange={(v) => patch({ publishedAt: v })}
                  placeholder="Leave blank to publish manually"
                />
              )}
            </Section>

            {/* Section: tax */}
            <Section title="Tax (GST)">
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="HSN / SAC code"
                  value={form.hsnCode}
                  onChange={(v) => patch({ hsnCode: v })}
                  mono
                  placeholder="6109"
                  disabled={isVendor}
                />
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    GST rate (%)
                  </span>
                  <select
                    value={form.gstRate}
                    onChange={(e) => patch({ gstRate: e.target.value })}
                    disabled={isVendor}
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                  >
                    <option value="">Not set</option>
                    {GST_RATE_OPTIONS.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}%
                      </option>
                    ))}
                  </select>
                  {errors.gstRate && (
                    <span className="text-[10px] text-red-600">{errors.gstRate}</span>
                  )}
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    Unit of measure (UQC)
                  </span>
                  <select
                    value={form.unitOfMeasure}
                    onChange={(e) => patch({ unitOfMeasure: e.target.value })}
                    disabled={isVendor}
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                  >
                    <option value="">Default (NOS)</option>
                    {COMMON_UQC.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    Supply type
                  </span>
                  <select
                    value={form.supplyType}
                    onChange={(e) => patch({ supplyType: e.target.value as GstSupplyType })}
                    disabled={isVendor}
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                  >
                    {GST_SUPPLY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </Section>

            {/* Section: variants — toggle between single + multi flow.
             *  Vendors may edit existing variant fields (price / stock) but
             *  cannot add variants or change the option structure. */}
            <Section title="Variants">
              <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.hasOptions}
                  onChange={(e) => handleToggleOptions(e.target.checked)}
                  disabled={isVendor}
                  className="size-3.5 accent-[#CEF17B] disabled:opacity-50"
                />
                This product has multiple variants (e.g. Size, Color)
              </label>

              {!form.hasOptions ? (
                // Single-variant inputs. Common fields stay inline; the rest
                // (cost, customs, inventory toggles, shipping, tax) live in a
                // collapsible "More options" panel so the dialog stays compact
                // for users who don't need them.
                <SingleVariantFields
                  variant={form.variant}
                  patch={patchVariant}
                  priceError={errors.price}
                  stockReadOnly={warehousingEnabled}
                />
              ) : (
                <div className="space-y-3 mt-3">
                  {/* Option-type editing is a structural change — hidden for
                   *  vendors, who can only edit existing variant fields. */}
                  {!isVendor && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Option types
                      </p>
                      <OptionsEditor
                        options={form.options}
                        onChange={(next) => patch({ options: next })}
                      />
                      {errors.options && (
                        <p className="mt-1 text-[10px] text-red-600">{errors.options}</p>
                      )}
                    </div>
                  )}

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Variants ({form.variants.length})
                      </p>
                      {isVendor ? null : !isEdit ? (
                        <button
                          type="button"
                          onClick={regenerateVariantsClient}
                          disabled={
                            form.options.length === 0 ||
                            form.options.some((o) => !o.name || o.values.length === 0)
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-input bg-white dark:bg-gray-900 px-2 py-1 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                        >
                          <Sparkles className="size-3" />
                          Add variants
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleGenerateInEdit()}
                          disabled={saving || !!optionsError()}
                          title={optionsError() ?? "Saves the option types, then creates every missing combination"}
                          className="inline-flex items-center gap-1 rounded-md border border-input bg-white dark:bg-gray-900 px-2 py-1 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                        >
                          {saving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Sparkles className="size-3" />
                          )}
                          Add missing variants
                        </button>
                      )}
                    </div>
                    {form.variants.length > 0 ? (
                      <VariantEditor
                        options={form.options}
                        variants={form.variants}
                        onChange={(next) => patch({ variants: next })}
                        stockReadOnly={warehousingEnabled}
                      />
                    ) : (
                      <p className="rounded-lg border border-dashed border-input bg-gray-50 dark:bg-gray-800/40 py-4 text-center text-[11px] text-muted-foreground">
                        Define option types, then click "Add variants".
                      </p>
                    )}
                    {errors.variants && (
                      <p className="mt-1 text-[10px] text-red-600">{errors.variants}</p>
                    )}
                  </div>
                </div>
              )}
            </Section>

            {/* Section: images — only in edit mode (need a product id to attach to).
             *  Gated behind MEDIA_UPLOAD_ENABLED while the upload feature is on hold.
             */}
            {MEDIA_UPLOAD_ENABLED && isEdit && product && (
              <Section title="Images">
                <ImageGalleryUploader
                  productId={product.id}
                  images={product.images ?? []}
                />
              </Section>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:opacity-50 transition-colors"
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {isEdit ? "Save changes" : "Create product"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Build the payload for the single-variant create / update flow from the
 * form's string-based variant state. Empty / unset fields collapse to
 * `undefined` so the server keeps schema defaults (e.g. trackQuantity=true
 * stays true on a fresh row when the user didn't touch the toggle).
 */
function buildSingleVariantPayload(v: FormState["variant"]): ProductVariantInput {
  return {
    price: parseFloat(v.price),
    sku: v.sku || undefined,
    compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : undefined,
    inventoryQuantity: v.inventoryQuantity ? parseInt(v.inventoryQuantity, 10) : 0,
    cost: v.cost ? parseFloat(v.cost) : undefined,
    barcode: v.barcode || undefined,
    weight: v.weight ? parseFloat(v.weight) : undefined,
    weightUnit: v.weight ? v.weightUnit : undefined,
    hsCode: v.hsCode || undefined,
    countryOfOrigin: v.countryOfOrigin
      ? v.countryOfOrigin.toUpperCase().slice(0, 2)
      : undefined,
    trackQuantity: v.trackQuantity,
    continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
    requiresShipping: v.requiresShipping,
    taxable: v.taxable,
  };
}

/**
 * Build a sparse update payload of fields that changed between the original
 * loaded variant and the current form state. Returns {} when nothing changed,
 * so the caller can skip a no-op `updateVariant` call.
 *
 * Compared in stable types: numeric fields are coerced to Number, optional
 * strings to (value || null), booleans straight. The DTO types ignore null
 * here — Prisma drops undefineds, so we send only diffed keys.
 */
function diffVariant(
  orig: ProductVariant,
  cur: ProductVariantInput,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const cmp = (a: unknown, b: unknown) =>
    a == null && b == null ? true : a === b;

  if (!cmp(Number(orig.price), Number(cur.price))) patch.price = Number(cur.price);
  if (!cmp(orig.sku ?? "", cur.sku ?? "")) patch.sku = cur.sku ?? "";
  if (!cmp(orig.barcode ?? "", cur.barcode ?? "")) patch.barcode = cur.barcode ?? "";

  const origCmp = orig.compareAtPrice == null ? null : Number(orig.compareAtPrice);
  const curCmp = cur.compareAtPrice == null ? null : Number(cur.compareAtPrice);
  if (!cmp(origCmp, curCmp)) patch.compareAtPrice = curCmp;

  const origCost = orig.cost == null ? null : Number(orig.cost);
  const curCost = cur.cost == null ? null : Number(cur.cost);
  if (!cmp(origCost, curCost)) patch.cost = curCost;

  if (!cmp(orig.inventoryQuantity, cur.inventoryQuantity ?? 0)) {
    patch.inventoryQuantity = cur.inventoryQuantity ?? 0;
  }
  if (!cmp(orig.trackQuantity ?? true, cur.trackQuantity ?? true)) {
    patch.trackQuantity = cur.trackQuantity ?? true;
  }
  if (!cmp(orig.continueSellingWhenOutOfStock ?? false, cur.continueSellingWhenOutOfStock ?? false)) {
    patch.continueSellingWhenOutOfStock = cur.continueSellingWhenOutOfStock ?? false;
  }
  if (!cmp(orig.requiresShipping ?? true, cur.requiresShipping ?? true)) {
    patch.requiresShipping = cur.requiresShipping ?? true;
  }
  const origWeight = orig.weight == null ? null : Number(orig.weight);
  const curWeight = cur.weight == null ? null : Number(cur.weight);
  if (!cmp(origWeight, curWeight)) patch.weight = curWeight;
  // A weight always carries a unit; "kg" is what the editor displays when
  // none was chosen, so that is what gets stored.
  const curUnit = curWeight != null ? (cur.weightUnit ?? "kg") : (cur.weightUnit ?? null);
  if (!cmp(orig.weightUnit ?? null, curUnit)) {
    patch.weightUnit = curUnit;
  }
  if (!cmp(orig.hsCode ?? null, cur.hsCode ?? null)) patch.hsCode = cur.hsCode ?? null;
  if (!cmp(orig.countryOfOrigin ?? null, cur.countryOfOrigin ?? null)) {
    patch.countryOfOrigin = cur.countryOfOrigin ?? null;
  }
  if (!cmp(orig.taxable ?? true, cur.taxable ?? true)) patch.taxable = cur.taxable ?? true;

  // GST override: null clears the override (= inherit from the product).
  if (!cmp(orig.hsnCode ?? null, cur.hsnCode ?? null)) patch.hsnCode = cur.hsnCode ?? null;
  const origRate = orig.gstRate == null ? null : Number(orig.gstRate);
  const curRate = cur.gstRate == null ? null : Number(cur.gstRate);
  if (!cmp(origRate, curRate)) patch.gstRate = curRate;
  if (!cmp(orig.unitOfMeasure ?? null, cur.unitOfMeasure ?? null)) {
    patch.unitOfMeasure = cur.unitOfMeasure ?? null;
  }
  if (!cmp(orig.supplyType ?? null, cur.supplyType ?? null)) {
    patch.supplyType = cur.supplyType ?? null;
  }

  if (!cmp(orig.option1 ?? null, cur.option1 ?? null)) patch.option1 = cur.option1 ?? null;
  if (!cmp(orig.option2 ?? null, cur.option2 ?? null)) patch.option2 = cur.option2 ?? null;
  if (!cmp(orig.option3 ?? null, cur.option3 ?? null)) patch.option3 = cur.option3 ?? null;
  if (!cmp(orig.position, cur.position ?? orig.position)) patch.position = cur.position;

  return patch;
}

/**
 * Inline field block for the single-variant flow. Common fields (Price,
 * Compare-at, SKU, Stock) stay always-visible; the rest collapse under a
 * "More options" toggle to mirror Shopify's product editor.
 *
 * The state lives in the parent (FormState.variant) and changes flow back
 * via the `patch` callback.
 */
function SingleVariantFields({
  variant,
  patch,
  priceError,
  stockReadOnly = false,
}: {
  variant: FormState["variant"];
  patch: (p: Partial<FormState["variant"]>) => void;
  priceError?: string;
  stockReadOnly?: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { data: org } = useCurrentOrg();
  const { isVendor } = useCurrentRole();
  const currency = org?.currency ?? "USD";

  return (
    <div className="space-y-3 mt-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Price"
          required
          error={priceError}
          value={variant.price}
          onChange={(v) => patch({ price: v })}
          type="number"
          step="0.01"
          placeholder="0.00"
        />
        <Field
          label="Compare-at price (optional)"
          value={variant.compareAtPrice}
          onChange={(v) => patch({ compareAtPrice: v })}
          type="number"
          step="0.01"
        />
        <Field
          label="SKU"
          value={variant.sku}
          onChange={(v) => patch({ sku: v })}
          mono
        />
        {variant.trackQuantity && stockReadOnly ? (
          <div className="flex flex-col">
            <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
              Stock on hand
            </span>
            {/* A link, not prose. Naming the destination without going there is
                how "where do I update stock?" became a support question. */}
            <p className="mt-1 h-9 flex items-center gap-1 text-xs text-muted-foreground">
              {variant.inventoryQuantity || "0"} —{" "}
              <Link
                to="/products/inventory"
                className="text-brand-strong underline underline-offset-2 hover:no-underline"
              >
                set per location in Inventory
              </Link>
            </p>
          </div>
        ) : variant.trackQuantity ? (
          <Field
            label="Stock on hand"
            value={variant.inventoryQuantity}
            onChange={(v) => patch({ inventoryQuantity: v })}
            type="number"
          />
        ) : (
          <div className="flex flex-col">
            <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
              Stock on hand
            </span>
            <p className="mt-1 h-9 flex items-center text-xs italic text-muted-foreground">
              Untracked
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#084734] hover:underline"
      >
        {advancedOpen ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        {advancedOpen ? "Hide" : "Show"} more options (cost, inventory, shipping, customs, tax)
      </button>

      {advancedOpen && (
        <div className="space-y-4 rounded-lg border border-input bg-gray-50/50 dark:bg-gray-800/30 p-4">
          {/* Pricing extras */}
          <FieldsSubsection title="Pricing">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Cost per item"
                value={variant.cost}
                onChange={(v) => patch({ cost: v })}
                type="number"
                step="0.01"
                placeholder="0.00"
              />
              <div className="flex flex-col">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  Profit / margin
                </span>
                <p className="mt-1 h-9 flex items-center text-xs font-medium text-gray-900 dark:text-gray-100">
                  {formatMargin(
                    variant.price ? parseFloat(variant.price) : null,
                    variant.cost ? parseFloat(variant.cost) : null,
                    currency,
                  )}
                </p>
              </div>
            </div>
          </FieldsSubsection>

          {/* Inventory */}
          <FieldsSubsection title="Inventory">
            <Toggle
              label="Track quantity"
              hint="Decrement stock when an order is placed."
              checked={variant.trackQuantity}
              onChange={(v) => patch({ trackQuantity: v })}
            />
            {variant.trackQuantity && (
              <Toggle
                label="Continue selling when out of stock"
                hint="Allow orders even when inventory hits 0."
                checked={variant.continueSellingWhenOutOfStock}
                onChange={(v) => patch({ continueSellingWhenOutOfStock: v })}
              />
            )}
          </FieldsSubsection>

          {/* Shipping */}
          <FieldsSubsection title="Shipping">
            <Toggle
              label="This is a physical product"
              hint="Off for digital downloads, services, gift cards."
              checked={variant.requiresShipping}
              onChange={(v) => patch({ requiresShipping: v })}
            />
            {variant.requiresShipping && (
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Weight"
                  value={variant.weight}
                  onChange={(v) => patch({ weight: v })}
                  type="number"
                  step="0.01"
                  placeholder="0.0"
                />
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    Weight unit
                  </span>
                  <select
                    value={variant.weightUnit}
                    onChange={(e) =>
                      patch({ weightUnit: e.target.value as WeightUnit })
                    }
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                  >
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                    <option value="oz">oz</option>
                    <option value="lb">lb</option>
                  </select>
                </label>
              </div>
            )}
          </FieldsSubsection>

          {/* Customs */}
          <FieldsSubsection title="Customs information">
            {/* Was "Barcode (UPC, ISBN, etc.)", which told the merchant to
                type a retail barcode here while the CRM quietly writes its own
                6-digit code into the same field. The shared definition says
                what actually happens. */}
            <Field
              label={CODE_TERMS.barcode.label}
              value={variant.barcode}
              onChange={(v) => patch({ barcode: v })}
              hint={CODE_TERMS.barcode.definition}
              mono
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="HS code"
                value={variant.hsCode}
                onChange={(v) => patch({ hsCode: v })}
                mono
                placeholder="6109.10"
              />
              <Field
                label="Country of origin (ISO-3166)"
                value={variant.countryOfOrigin}
                onChange={(v) =>
                  patch({ countryOfOrigin: v.toUpperCase().slice(0, 2) })
                }
                mono
                placeholder="IN"
              />
            </div>
          </FieldsSubsection>

          {/* Tax */}
          <FieldsSubsection title="Tax">
            <Toggle
              label="Charge tax on this variant"
              hint="When off, this variant is exempt from automatic tax."
              checked={variant.taxable}
              onChange={(v) => patch({ taxable: v })}
              disabled={isVendor}
            />
          </FieldsSubsection>
        </div>
      )}
    </div>
  );
}

function FieldsSubsection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border border-input bg-white dark:bg-gray-800/40 p-2.5 ${
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 accent-[#CEF17B]"
      />
      <div className="flex-1">
        <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
          {label}
        </span>
        {hint && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
        )}
      </div>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  step,
  mono = false,
  required = false,
  error,
  placeholder,
  disabled = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
  mono?: boolean;
  required?: boolean;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 h-9 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 ${
          error ? "border-red-400" : "border-input"
        } ${mono ? "font-mono" : ""} ${
          disabled ? "cursor-not-allowed opacity-60" : ""
        }`}
      />
      {error && <span className="mt-1 block text-[10px] text-red-600">{error}</span>}
      {hint && !error && (
        <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}
