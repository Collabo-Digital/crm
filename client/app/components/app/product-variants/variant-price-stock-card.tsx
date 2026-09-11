import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Search } from "lucide-react";
import { toast } from "sonner";

import { SectionCard } from "~/components/app/section-card";
import { Input } from "~/components/ui/input";
import { Tip } from "~/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useDebounced } from "~/hooks/use-debounced";
import { cn, formatCurrency } from "~/lib/utils";
import type { VariantDraft } from "~/lib/variant-draft";
import {
  buildVariantGroups,
  computeGroupMeta,
  formatVariantTitle,
  hasGstOverride,
  isColourOption,
  isDefaultVariantLabel,
  matchesVariantSearch,
  plural,
  type GroupMeta,
  type ProductTaxDefaults,
} from "~/lib/variant-grouping";
import type {
  ProductImage,
  ProductOption,
  ProductStatus,
  ProductVariant,
  UpdateVariantRequest,
} from "~/types/api";
import { VariantInlineEditor } from "./variant-inline-editor";
import { VariantSwatch } from "./variant-swatch";

/** Variant · Price · Stock · SKU · (disclosure chevron) */
const COLUMN_COUNT = 5;

export function VariantPriceStockCard({
  productTitle,
  productImages,
  productStatus,
  variants,
  committedOptions,
  currency,
  drafts,
  productTax,
  onSaveVariant,
  onVariantPersisted,
  isSavingVariant,
  warehousingEnabled,
  trackForced,
  oversellForced,
  isVendor,
}: {
  productTitle: string;
  productImages: ProductImage[];
  productStatus: ProductStatus;
  variants: ProductVariant[];
  committedOptions: ProductOption[];
  currency: string;
  drafts: Record<string, VariantDraft>;
  productTax: ProductTaxDefaults;
  onSaveVariant: (variantId: string, data: UpdateVariantRequest) => Promise<void>;
  onVariantPersisted: (variant: ProductVariant, patch: Partial<VariantDraft>) => void;
  isSavingVariant: boolean;
  warehousingEnabled: boolean;
  trackForced: boolean;
  oversellForced: boolean;
  isVendor: boolean;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);

  const query = useDebounced(search, 200).trim().toLowerCase();

  const option1Name = committedOptions[0]?.name ?? null;
  const childNoun = (committedOptions[1]?.name ?? "variant").toLowerCase();

  // Filter before grouping, but never filter out the row being edited — a panel
  // vanishing mid-edit takes the merchant's unsaved work with it.
  const visible = useMemo(
    () =>
      query
        ? variants.filter(
          (v) => v.id === editingId || matchesVariantSearch(v, query),
        )
        : variants,
    [variants, query, editingId],
  );

  const groups = useMemo(() => buildVariantGroups(visible), [visible]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function requestEdit(variantId: string) {
    if (editingId === variantId) {
      if (editorDirty) {
        toast.info("Save or cancel your changes first.");
        return;
      }
      setEditingId(null);
      return;
    }
    if (editingId && editorDirty) {
      toast.info("Save or cancel your changes first.");
      return;
    }
    setEditingId(variantId);
  }

  const editingVariant = editingId
    ? variants.find((v) => v.id === editingId) ?? null
    : null;

  function renderEditor(v: ProductVariant) {
    if (editingId !== v.id || !editingVariant) return null;
    return (
      <VariantInlineEditor
        key={v.id}
        variant={editingVariant}
        draft={drafts[v.id]}
        productTax={productTax}
        productStatus={productStatus}
        currency={currency}
        colSpan={COLUMN_COUNT}
        warehousingEnabled={warehousingEnabled}
        trackForced={trackForced}
        oversellForced={oversellForced}
        isVendor={isVendor}
        isSaving={isSavingVariant}
        onSaveVariant={onSaveVariant}
        onSaved={(patch) => onVariantPersisted(editingVariant, patch)}
        onCancel={() => setEditingId(null)}
        onDirtyChange={setEditorDirty}
      />
    );
  }

  return (
    <SectionCard
      title="Set a price and stock for each one"
      description="Click a variant to edit it. Everything you don't set follows the product."
      icon={
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-micro font-semibold text-brand-foreground">
          2
        </span>
      }
      action={
        variants.length > 1 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a variant"
              aria-label="Find a variant"
              className="h-8 w-52 pl-8"
            />
          </div>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-6">Variant</TableHead>
              <TableHead className="px-4 text-right">Price</TableHead>
              <TableHead className="px-4 text-right">
                {/* A cross-location total, like Shopify's own variant list. The
                    per-location figures — and the only way to edit them — live
                    in the editor panel below each row. */}
                <Tip text="Total across every location. Open a variant to see and edit the quantity at each one.">
                  <span className="cursor-help underline decoration-dotted underline-offset-4">
                    Stock · all locations
                  </span>
                </Tip>
              </TableHead>
              <TableHead className="px-4">SKU</TableHead>
              <TableHead className="w-10 px-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="px-6 py-10 text-center text-caption text-muted-foreground"
                >
                  No variant matches “{search.trim()}”.
                </TableCell>
              </TableRow>
            )}

            {groups.map((group) => {
              // A single-variant group has nothing to expand into — render the
              // variant itself rather than a header that hides one row.
              if (group.leaf) {
                const v = group.variants[0];
                return (
                  <Fragment key={group.key}>
                    <VariantChildRow
                      variant={v}
                      label={formatVariantTitle(v, productTitle)}
                      draft={drafts[v.id]}
                      currency={currency}
                      isOpen={editingId === v.id}
                      onToggle={() => requestEdit(v.id)}
                    />
                    {renderEditor(v)}
                  </Fragment>
                );
              }

              const holdsEditing = group.variants.some((v) => v.id === editingId);
              const isOpen = !!query || expanded.has(group.key) || holdsEditing;
              const meta = computeGroupMeta(group.variants, drafts, childNoun);
              const swatchImage =
                productImages.find(
                  (img) =>
                    img.id === group.variants.find((v) => v.imageId)?.imageId,
                )?.src ?? null;

              return (
                <Fragment key={group.key}>
                  <TableRow
                    className="cursor-pointer bg-muted/40 hover:bg-muted/60"
                    onClick={() => toggleGroup(group.key)}
                  >
                    <TableCell className="px-6 py-3">
                      <button
                        type="button"
                        className="flex items-center gap-3 text-left"
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(group.key);
                        }}
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <VariantSwatch
                          value={group.key}
                          optionName={isColourOption(option1Name) ? option1Name : null}
                          imageSrc={swatchImage}
                        />
                        <span className="text-body font-semibold text-foreground">
                          {group.key}
                        </span>
                      </button>
                    </TableCell>
                    {/* The summary sits on the same line as the name, starting
                        at the Price column — see the reference layout. */}
                    <TableCell colSpan={COLUMN_COUNT - 1} className="px-4 py-3">
                      <GroupMetaLine meta={meta} currency={currency} />
                    </TableCell>
                  </TableRow>

                  {isOpen &&
                    group.variants.map((v) => (
                      <Fragment key={v.id}>
                        <VariantChildRow
                          variant={v}
                          label={
                            isDefaultVariantLabel(v.option2)
                              ? formatVariantTitle(v, productTitle)
                              : v.option2!
                          }
                          subtitle={
                            isDefaultVariantLabel(v.option3) ? null : v.option3
                          }
                          indented
                          draft={drafts[v.id]}
                          currency={currency}
                          isOpen={editingId === v.id}
                          onToggle={() => requestEdit(v.id)}
                        />
                        {renderEditor(v)}
                      </Fragment>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="border-t px-6 py-3 text-caption text-muted-foreground">
        {query
          ? `${visible.length} of ${plural(variants.length, "variant")} match “${search.trim()}”`
          : `${plural(groups.length, (option1Name ?? "group").toLowerCase())} · ${plural(
            variants.length,
            "variant",
          )}`}
      </div>
    </SectionCard>
  );
}

function GroupMetaLine({ meta, currency }: { meta: GroupMeta; currency: string }) {
  const parts: Array<{ text: string; warn?: boolean }> = [
    { text: plural(meta.childCount, meta.childNoun) },
  ];

  if (meta.priceMin !== null && meta.priceMax !== null) {
    parts.push({
      text:
        meta.priceMin === meta.priceMax
          ? formatCurrency(meta.priceMin, currency)
          : `${formatCurrency(meta.priceMin, currency)} – ${formatCurrency(
            meta.priceMax,
            currency,
          )}`,
    });
  }

  if (meta.trackedStock === null) {
    parts.push({ text: "Not tracked" });
  } else if (meta.trackedStock === 0) {
    parts.push({ text: "Out of stock", warn: true });
  } else {
    parts.push({ text: `${meta.trackedStock} in stock` });
  }

  if (meta.untrackedCount > 0 && meta.trackedStock !== null) {
    parts.push({ text: `${meta.untrackedCount} untracked` });
  }

  return (
    <span className="text-caption text-muted-foreground">
      {parts.map((part, i) => (
        <Fragment key={part.text}>
          {i > 0 && " · "}
          <span className={part.warn ? "text-warning" : undefined}>{part.text}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * One variant. Values are read-only here — the row is a summary, and the whole
 * row is the way into the editor (there is no separate Edit button), so the
 * chevron on the right is the affordance.
 */
function VariantChildRow({
  variant: v,
  label,
  subtitle,
  indented = false,
  draft,
  currency,
  isOpen,
  onToggle,
}: {
  variant: ProductVariant;
  label: string;
  subtitle?: string | null;
  indented?: boolean;
  draft: VariantDraft | undefined;
  currency: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const tracked = v.trackQuantity !== false;
  const sku = draft?.sku ?? v.sku ?? "";
  const price = Number(draft?.price ?? v.price ?? 0);
  const stock = Number.parseInt(
    draft?.inventoryQuantity ?? String(v.inventoryQuantity ?? 0),
    10,
  );

  return (
    <TableRow
      onClick={onToggle}
      aria-expanded={isOpen}
      className={cn(
        "cursor-pointer",
        isOpen ? "bg-brand/15 hover:bg-brand/20" : "hover:bg-muted/30",
      )}
    >
      <TableCell className={cn("px-6 py-3", indented && "pl-14")}>
        <span className="block text-body font-medium text-foreground">{label}</span>
        {subtitle && (
          <span className="block text-caption text-muted-foreground">{subtitle}</span>
        )}
        {hasGstOverride(v) && (
          <span
            className="mt-1 inline-flex rounded-full bg-warning-subtle px-1.5 py-0.5 text-micro font-medium text-warning"
            title="This variant overrides the product's GST classification"
          >
            GST override
          </span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-right text-body font-medium tabular-nums text-foreground">
        {Number.isFinite(price) ? formatCurrency(price, currency) : "—"}
      </TableCell>
      <TableCell
        className={cn(
          "px-4 py-3 text-right text-body tabular-nums",
          !tracked && "text-muted-foreground",
          tracked && stock === 0 && "text-warning-strong",
          tracked && stock < 0 && "text-danger",
        )}
      >
        {tracked ? (Number.isFinite(stock) ? stock : "—") : "Untracked"}
      </TableCell>
      <TableCell className="px-4 py-3">
        {sku.trim() ? (
          <span className="font-mono text-caption text-muted-foreground">{sku}</span>
        ) : (
          <span className="inline-flex rounded-full bg-warning-subtle px-2 py-0.5 text-micro font-medium text-warning">
            Needs a SKU
          </span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
        {isOpen ? (
          <ChevronUp className="ml-auto size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto size-4 text-muted-foreground" />
        )}
      </TableCell>
    </TableRow>
  );
}
