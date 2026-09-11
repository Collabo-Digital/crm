import { useMemo, useState } from "react";
import { Link } from "react-router";
import { GripVertical, MoreVertical, Trash2, X } from "lucide-react";
import type { GstSupplyType, ProductOption, ProductVariantInput } from "~/types/api";
import { COMMON_UQC, GST_RATE_OPTIONS, GST_SUPPLY_TYPES } from "~/lib/gst-uqc";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { formatMargin } from "~/lib/utils";

/**
 * Repeating-row editor for product variants. Each row exposes the most-used
 * fields inline (option values, SKU, price, compare-at, stock). A "..." button
 * opens a side panel with the full Phase-2 field set: cost/margin, inventory
 * controls, shipping, customs, tax.
 *
 * Drag-to-reorder uses native HTML drag-and-drop.
 *
 * The parent owns the `variants` state and is responsible for keeping the
 * cartesian-product invariant (this component does NOT auto-generate rows).
 */
export function VariantEditor({
  options,
  variants,
  onChange,
  stockReadOnly = false,
}: {
  options: ProductOption[];
  variants: ProductVariantInput[];
  onChange: (next: ProductVariantInput[]) => void;
  /**
   * Warehousing orgs keep stock per warehouse; the variant column is a cache
   * the ledger recomputes, so typing into it here would be silently undone.
   */
  stockReadOnly?: boolean;
}) {
  const optionNames = useMemo(
    () => options.map((o) => o.name).filter(Boolean),
    [options],
  );
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function patchVariant(idx: number, patch: Partial<ProductVariantInput>) {
    onChange(variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  }

  function removeVariant(idx: number) {
    if (variants.length <= 1) return;
    onChange(variants.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...variants];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next.map((v, i) => ({ ...v, position: i + 1 })));
  }

  const handleDrop = (e: React.DragEvent, to: number) => {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData("text/plain");
    const from = parseInt(fromStr, 10);
    if (!Number.isFinite(from)) return;
    reorder(from, to);
  };

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-input">
        <table className="w-full text-xs">
          <thead className="bg-gray-50/60 dark:bg-gray-800/60 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-6 px-2 py-2"></th>
              <th className="px-2 py-2 text-left font-medium">Title</th>
              {optionNames[0] && (
                <th className="px-2 py-2 text-left font-medium">{optionNames[0]}</th>
              )}
              {optionNames[1] && (
                <th className="px-2 py-2 text-left font-medium">{optionNames[1]}</th>
              )}
              {optionNames[2] && (
                <th className="px-2 py-2 text-left font-medium">{optionNames[2]}</th>
              )}
              <th className="px-2 py-2 text-left font-medium">SKU</th>
              <th className="px-2 py-2 text-right font-medium">Price</th>
              <th className="px-2 py-2 text-right font-medium">Compare-at</th>
              <th className="px-2 py-2 text-right font-medium">Stock</th>
              <th className="w-12 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {variants.map((v, idx) => {
              const labels = [v.option1, v.option2, v.option3].filter(Boolean) as string[];
              const title = labels.length > 0 ? labels.join(" / ") : "Default Title";
              const stockHidden = v.trackQuantity === false;
              return (
                <tr
                  key={idx}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(idx))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, idx)}
                  className="bg-white dark:bg-gray-900"
                >
                  <td className="px-2 py-2 text-muted-foreground cursor-grab">
                    <GripVertical className="size-3.5" />
                  </td>
                  <td className="px-2 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    {title}
                  </td>
                  {optionNames[0] && (
                    <td className="px-2 py-2">
                      <input
                        value={v.option1 ?? ""}
                        onChange={(e) => patchVariant(idx, { option1: e.target.value })}
                        list={`opt-list-0`}
                        className="h-7 w-full rounded border border-input bg-white dark:bg-gray-900 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                      />
                    </td>
                  )}
                  {optionNames[1] && (
                    <td className="px-2 py-2">
                      <input
                        value={v.option2 ?? ""}
                        onChange={(e) => patchVariant(idx, { option2: e.target.value })}
                        list={`opt-list-1`}
                        className="h-7 w-full rounded border border-input bg-white dark:bg-gray-900 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                      />
                    </td>
                  )}
                  {optionNames[2] && (
                    <td className="px-2 py-2">
                      <input
                        value={v.option3 ?? ""}
                        onChange={(e) => patchVariant(idx, { option3: e.target.value })}
                        list={`opt-list-2`}
                        className="h-7 w-full rounded border border-input bg-white dark:bg-gray-900 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                      />
                    </td>
                  )}
                  <td className="px-2 py-2">
                    <input
                      value={v.sku ?? ""}
                      onChange={(e) => patchVariant(idx, { sku: e.target.value })}
                      placeholder="—"
                      className="h-7 w-24 rounded border border-input bg-white dark:bg-gray-900 px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      value={v.price === undefined ? "" : v.price}
                      onChange={(e) =>
                        patchVariant(idx, {
                          price: e.target.value === "" ? 0 : parseFloat(e.target.value),
                        })
                      }
                      className="h-7 w-20 rounded border border-input bg-white dark:bg-gray-900 px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      value={v.compareAtPrice ?? ""}
                      onChange={(e) =>
                        patchVariant(idx, {
                          compareAtPrice: e.target.value === "" ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="h-7 w-20 rounded border border-input bg-white dark:bg-gray-900 px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#CEF17B]"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    {stockHidden ? (
                      <span
                        className="text-[10px] italic text-muted-foreground"
                        title="Inventory tracking is off for this variant"
                      >
                        Untracked
                      </span>
                    ) : (
                      <input
                        type="number"
                        value={v.inventoryQuantity ?? 0}
                        onChange={(e) =>
                          patchVariant(idx, {
                            inventoryQuantity: e.target.value === "" ? 0 : parseInt(e.target.value, 10),
                          })
                        }
                        disabled={stockReadOnly}
                        title={stockReadOnly ? "Set per warehouse in Inventory" : undefined}
                        className="h-7 w-16 rounded border border-input bg-white dark:bg-gray-900 px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#CEF17B] disabled:opacity-50"
                      />
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setExpandedIdx(idx)}
                        title="More options (cost, weight, customs, tax)"
                        className="rounded p-1 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900"
                      >
                        <MoreVertical className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeVariant(idx)}
                        disabled={variants.length <= 1}
                        title="Delete variant"
                        className="rounded p-1 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-red-600 disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Datalists for option-value autocomplete from the parent's options definition. */}
        {options.map((opt, i) => (
          <datalist key={i} id={`opt-list-${i}`}>
            {opt.values.map((val) => (
              <option key={val} value={val} />
            ))}
          </datalist>
        ))}
      </div>

      {/* Side panel for the focused variant's full field set. */}
      {expandedIdx !== null && variants[expandedIdx] && (
        <VariantDetailPanel
          variant={variants[expandedIdx]}
          onChange={(patch) => patchVariant(expandedIdx, patch)}
          onClose={() => setExpandedIdx(null)}
          stockReadOnly={stockReadOnly}
        />
      )}
    </>
  );
}

/**
 * Slide-in side panel exposing the full Phase-2 variant field set:
 *   - Pricing (cost + computed margin)
 *   - Inventory (track + continue-selling)
 *   - Shipping (requires-shipping + weight)
 *   - Customs (barcode + HS code + country of origin)
 *   - Tax (taxable)
 *
 * Mutates the variant in-place via `onChange`. Persistence is the parent
 * dialog's job — in CREATE mode it goes with the create payload; in EDIT mode
 * the dialog batch-syncs each modified variant on Save.
 */
function VariantDetailPanel({
  variant,
  onChange,
  onClose,
  stockReadOnly = false,
}: {
  variant: ProductVariantInput;
  onChange: (patch: Partial<ProductVariantInput>) => void;
  onClose: () => void;
  stockReadOnly?: boolean;
}) {
  const { data: org } = useCurrentOrg();
  // Vendors cannot change the per-variant tax flag — render it read-only.
  const { isVendor } = useCurrentRole();
  const currency = org?.currency ?? "USD";
  const titleLabels = [variant.option1, variant.option2, variant.option3].filter(Boolean) as string[];
  const variantTitle = titleLabels.length > 0 ? titleLabels.join(" / ") : "Default Title";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-end bg-black/30"
      onClick={onClose}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col bg-white dark:bg-gray-900 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Variant details
            </p>
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {variantTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Pricing */}
          <PanelSection title="Pricing">
            <div className="grid grid-cols-2 gap-3">
              <PanelField
                label="Price"
                type="number"
                step="0.01"
                value={variant.price ?? 0}
                onChange={(v) => onChange({ price: parseFloat(v) || 0 })}
              />
              <PanelField
                label="Compare-at price"
                type="number"
                step="0.01"
                value={variant.compareAtPrice ?? ""}
                onChange={(v) => onChange({ compareAtPrice: v === "" ? undefined : parseFloat(v) })}
              />
              <PanelField
                label="Cost per item"
                type="number"
                step="0.01"
                value={variant.cost ?? ""}
                onChange={(v) => onChange({ cost: v === "" ? undefined : parseFloat(v) })}
              />
              <div className="flex flex-col">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  Profit / margin
                </span>
                <p className="mt-1 h-9 flex items-center text-xs font-medium text-gray-900 dark:text-gray-100">
                  {formatMargin(variant.price, variant.cost, currency)}
                </p>
              </div>
            </div>
          </PanelSection>

          {/* Inventory */}
          <PanelSection title="Inventory">
            <PanelToggle
              label="Track quantity"
              hint="Decrement stock when an order is placed."
              checked={variant.trackQuantity !== false}
              onChange={(checked) => onChange({ trackQuantity: checked })}
            />
            {variant.trackQuantity !== false && (
              <>
                {stockReadOnly ? (
                  <div className="flex flex-col">
                    <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                      Stock on hand
                    </span>
                    {/* See product-form-dialog: the destination is a link so
                        the merchant can actually reach it. */}
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      {variant.inventoryQuantity ?? 0} —{" "}
                      <Link
                        to="/products/inventory"
                        className="text-brand-strong underline underline-offset-2 hover:no-underline"
                      >
                        set per location in Inventory
                      </Link>
                    </p>
                  </div>
                ) : (
                  <PanelField
                    label="Stock on hand"
                    type="number"
                    value={variant.inventoryQuantity ?? 0}
                    onChange={(v) => onChange({ inventoryQuantity: v === "" ? 0 : parseInt(v, 10) })}
                  />
                )}
                <PanelToggle
                  label="Continue selling when out of stock"
                  hint="Allow orders even when inventory is 0."
                  checked={variant.continueSellingWhenOutOfStock === true}
                  onChange={(checked) => onChange({ continueSellingWhenOutOfStock: checked })}
                />
              </>
            )}
          </PanelSection>

          {/* Shipping */}
          <PanelSection title="Shipping">
            <PanelToggle
              label="This is a physical product"
              hint="Off for digital downloads, services, etc."
              checked={variant.requiresShipping !== false}
              onChange={(checked) => onChange({ requiresShipping: checked })}
            />
            {variant.requiresShipping !== false && (
              <div className="grid grid-cols-2 gap-3">
                <PanelField
                  label="Weight"
                  type="number"
                  step="0.01"
                  value={variant.weight ?? ""}
                  onChange={(v) =>
                    onChange({
                      weight: v === "" ? undefined : parseFloat(v),
                      // The select below DISPLAYS "kg" as its default without
                      // ever writing it, so a weight typed here used to save
                      // with no unit at all.
                      weightUnit: v === "" ? variant.weightUnit : (variant.weightUnit ?? "kg"),
                    })
                  }
                />
                <label className="block">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                    Weight unit
                  </span>
                  <select
                    value={variant.weightUnit ?? "kg"}
                    onChange={(e) =>
                      onChange({ weightUnit: e.target.value as "g" | "kg" | "oz" | "lb" })
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
          </PanelSection>

          {/* Customs */}
          <PanelSection title="Customs information">
            <PanelField
              label="Barcode (UPC, ISBN, etc.)"
              value={variant.barcode ?? ""}
              onChange={(v) => onChange({ barcode: v || undefined })}
              mono
            />
            <PanelField
              label="HS code (customs — sent to Shopify; invoices use the GST HSN below)"
              value={variant.hsCode ?? ""}
              onChange={(v) => onChange({ hsCode: v || undefined })}
              mono
              placeholder="6109.10"
            />
            <PanelField
              label="Country of origin (ISO-3166 alpha-2)"
              value={variant.countryOfOrigin ?? ""}
              onChange={(v) => onChange({ countryOfOrigin: v ? v.toUpperCase() : undefined })}
              mono
              placeholder="IN"
            />
          </PanelSection>

          {/* Tax */}
          <PanelSection title="Tax">
            <PanelToggle
              label="Charge tax on this variant"
              hint="When off, the variant is exempt from automatic tax."
              checked={variant.taxable !== false}
              onChange={(checked) => onChange({ taxable: checked })}
              disabled={isVendor}
            />
            <p className="text-[10px] text-gray-500 dark:text-gray-400">
              GST override — leave blank to use the product&apos;s HSN, rate, unit
              and supply type. Set only when this variant is classified differently.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  HSN / SAC override
                </span>
                <input
                  value={variant.hsnCode ?? ""}
                  onChange={(e) => onChange({ hsnCode: e.target.value || undefined })}
                  disabled={isVendor}
                  placeholder="Same as product"
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  GST rate override
                </span>
                <select
                  value={variant.gstRate == null ? "" : String(Number(variant.gstRate))}
                  onChange={(e) =>
                    onChange({
                      gstRate: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                  disabled={isVendor}
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                >
                  <option value="">Same as product</option>
                  {GST_RATE_OPTIONS.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}%
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  Unit of measure override
                </span>
                <select
                  value={variant.unitOfMeasure ?? ""}
                  onChange={(e) => onChange({ unitOfMeasure: e.target.value || undefined })}
                  disabled={isVendor}
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                >
                  <option value="">Same as product</option>
                  {COMMON_UQC.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
                  Supply type override
                </span>
                <select
                  value={variant.supplyType ?? ""}
                  onChange={(e) =>
                    onChange({
                      supplyType:
                        e.target.value === "" ? undefined : (e.target.value as GstSupplyType),
                    })
                  }
                  disabled={isVendor}
                  className="mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50"
                >
                  <option value="">Same as product</option>
                  {GST_SUPPLY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </PanelSection>
        </div>

        <footer className="border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F]"
          >
            Done
          </button>
          <p className="mt-1.5 text-[10px] text-muted-foreground text-center">
            Changes save when you click "Save changes" / "Create product".
          </p>
        </footer>
      </aside>
    </div>
  );
}

function PanelSection({
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

function PanelField({
  label,
  value,
  onChange,
  type = "text",
  step,
  mono = false,
  placeholder,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
      </span>
      <input
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

function PanelToggle({
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
