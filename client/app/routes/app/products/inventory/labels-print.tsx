import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Barcode, RefreshCw } from "lucide-react";
import { AdvancedPrintSettings } from "~/components/app/labels/advanced-print-settings";
import { CustomStockFields } from "~/components/app/labels/custom-stock-fields";
import type { LabelField } from "~/components/app/labels/label-artwork";
import { LabelContentOptions } from "~/components/app/labels/label-content-options";
import { LabelPagePreview } from "~/components/app/labels/label-page-preview";
import { LabelPrintStyles } from "~/components/app/labels/label-print-styles";
import { LabelQuantityRows } from "~/components/app/labels/label-quantity-rows";
import { LabelSheet } from "~/components/app/labels/label-sheet";
import {
  PrintAction,
  PrintSettingsCard,
  PrintWarnings,
  type LabelWarning,
} from "~/components/app/labels/print-summary-card";
import { StockFamilyTabs } from "~/components/app/labels/stock-family-tabs";
import type { StockFitSummary } from "~/components/app/labels/stock-size-card";
import { StockSizeGrid } from "~/components/app/labels/stock-size-grid";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useGenerateBarcodesMutation } from "~/hooks/use-inventory-mutations";
import { inventoryKeys } from "~/hooks/use-inventory-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import {
  classifyFit,
  measureBarcode,
  MIN_BAR_HEIGHT_MM,
  MIN_BAR_HEIGHT_SMALL_MM,
  planBarcode,
  type BarcodeMetrics,
  type BarcodePlan,
} from "~/lib/barcode";
import { fitRemedy, findFittingPreset, labelLayout } from "~/lib/label-fit";
import {
  ADVANCED_OPEN_KEY,
  DEFAULT_OPTIONS,
  familyOfOptions,
  hasCustomAdvanced,
  INTRO_DISMISSED_KEY,
  isFirstVisit,
  loadFlag,
  loadOptions,
  MAX_LABELS,
  MAX_QTY_PER_VARIANT,
  saveFlag,
  saveOptions,
  type LabelOptions,
} from "~/lib/label-options";
import {
  chunkPages,
  CUSTOM_PRESET_ID,
  findPreset,
  LABEL_PRESETS,
  presetProfileMap,
  presetsInFamily,
  resolveProfile,
  type CustomStock,
  type StockFamily,
} from "~/lib/label-stock";
import { inventoryService } from "~/services/inventory.service";
import type { LabelData } from "~/types/api";

/**
 * Barcode label printing.
 *
 * Three layers, and they stay separate: the STOCK (a preset or a custom W×H)
 * decides page geometry, the LAYOUT (across/down, gaps, margins) decides where
 * labels sit on it, and the CONTENT toggles decide what goes inside. One
 * barcode engine (`~/lib/barcode`) serves every size — there is never a
 * per-size generator.
 *
 * The screen is an editor: controls on the left, a live scaled preview and the
 * consequences on the right. The **print DOM is separate from the preview** —
 * `<LabelSheet>` holds every page at full size and is hidden on screen by
 * `@media screen`, while the rail renders the same `<LabelPage>` under a
 * transform. Read the header of `label-print-styles.tsx` before touching
 * either; the interaction between the print whitelist and that hide rule is the
 * difference between printing and printing nothing.
 *
 * `<LabelSheet>` MUST stay a direct child of the route root. No ancestor may
 * carry padding, overflow, max-height or transform — a transform ancestor
 * breaks CSS fragmentation and collapses every page onto one.
 *
 * Rendered chrome-free: the route ends in `/print`, which the app layout's
 * existing regex treats like packing-slip/pick-slip. Options persist in
 * localStorage (same pattern as order-slip.tsx).
 */

/** One row per media family, in the order the pills show them. */
const FAMILY_LABEL: Record<StockFamily, string> = {
  roll: "sticker roll",
  jewellery: "jewellery tag",
  sheet: "A4 sheet",
  custom: "custom stock",
};

/** The preset a family lands on when its pill is clicked. */
function defaultPresetFor(family: StockFamily): string {
  if (family === "custom") return CUSTOM_PRESET_ID;
  const list = presetsInFamily(family);
  const pick = list.find((p) => p.recommended) ?? list.find((p) => p.common) ?? list[0];
  return pick?.id ?? DEFAULT_OPTIONS.presetId;
}

export default function LabelsPrintPage() {
  const [searchParams] = useSearchParams();
  const variantIds = useMemo(
    () => (searchParams.get("variantIds") ?? "").split(",").filter(Boolean),
    [searchParams],
  );

  const labels = useQuery({
    queryKey: [...inventoryKeys.all, "label-data", variantIds],
    queryFn: () => inventoryService.labelData(variantIds),
    enabled: variantIds.length > 0,
  });

  const { data: org } = useCurrentOrg();
  const currency = org?.currency ?? "INR";
  const generateBarcodes = useGenerateBarcodesMutation();

  const [options, setOptions] = useState<LabelOptions>(loadOptions);
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // View state, deliberately outside LabelOptions — that record stays a
  // description of what gets printed and nothing else.
  const [family, setFamily] = useState<StockFamily>(() => familyOfOptions(options));
  const [showAll, setShowAll] = useState<boolean>(() => {
    // Never hide the selected card behind a disclosure.
    const preset = findPreset(options.presetId);
    return Boolean(preset && !preset.common);
  });
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(
    // Forced open when something in there is already off-default: a collapsed
    // panel silently shifting the output by 2 mm is how support tickets start.
    () => loadFlag(ADVANCED_OPEN_KEY, false) || hasCustomAdvanced(options),
  );
  const [introDismissed, setIntroDismissed] = useState<boolean>(
    () => loadFlag(INTRO_DISMISSED_KEY, false) || !isFirstVisit(),
  );
  const [hover, setHover] = useState<LabelField | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  useEffect(() => saveOptions(options), [options]);
  useEffect(() => saveFlag(ADVANCED_OPEN_KEY, advancedOpen), [advancedOpen]);
  useEffect(() => saveFlag(INTRO_DISMISSED_KEY, introDismissed), [introDismissed]);

  // Default each variant's label count to its on-hand quantity (min 1) —
  // the "20 units → 20 identical labels" flow.
  useEffect(() => {
    if (!labels.data) return;
    setQuantities((prev) => {
      const next = { ...prev };
      for (const l of labels.data) {
        if (next[l.variantId] === undefined) {
          next[l.variantId] = Math.max(1, Math.min(l.defaultQty, MAX_QTY_PER_VARIANT));
        }
      }
      return next;
    });
  }, [labels.data]);

  const profile = useMemo(
    () => resolveProfile({ presetId: options.presetId, custom: options.custom }),
    [options.presetId, options.custom],
  );
  const isSheet = profile.kind === "sheet";
  const selectedPreset = findPreset(options.presetId);
  const defaultDpi = selectedPreset?.defaultDpi ?? DEFAULT_OPTIONS.dpi;

  const rows = useMemo(() => labels.data ?? [], [labels.data]);

  /**
   * Stock-independent measurements, one JsBarcode encode per distinct code.
   * Everything that asks "would this fit on that?" reads from here — the size
   * cards need a verdict for every code against every preset, and encoding that
   * matrix would be hundreds of encodes per render.
   */
  const metrics = useMemo(() => {
    const map = new Map<string, BarcodeMetrics>();
    for (const l of rows) {
      if (l.barcode) map.set(l.variantId, measureBarcode(l.barcode));
    }
    return map;
  }, [rows]);

  /**
   * Does the run contain a GS1 code at all? The one thing that can remove a
   * slot, because it is not a preference — the same condition that decides
   * whether the "Barcode number" checkbox is offered.
   */
  const hriPossible = useMemo(
    () => [...metrics.values()].some((m) => m.symbology !== "CODE128"),
    [metrics],
  );

  /**
   * The fixed slot heights for this stock. The planner reserves against these
   * and the renderer draws them — one source of truth, or the label overflows
   * its own box and `overflow: hidden` eats the bottom row.
   *
   * Note what it does NOT depend on: the content checkboxes. That is what keeps
   * the bars the same size and in the same place however the label is
   * configured.
   */
  const layout = useMemo(() => labelLayout(profile, hriPossible), [profile, hriPossible]);

  // One plan per VARIANT, not per printed copy — at most 200 distinct codes
  // against up to 1000 labels.
  const plans = useMemo(() => {
    const map = new Map<string, BarcodePlan>();
    const inWindow = Boolean(profile.printableWindows);
    const minBar = inWindow ? MIN_BAR_HEIGHT_SMALL_MM : MIN_BAR_HEIGHT_MM;
    for (const l of rows) {
      if (!l.barcode || !metrics.has(l.variantId)) continue;
      map.set(
        l.variantId,
        planBarcode({
          value: l.barcode,
          availableMm: profile.contentWidthMm,
          dpi: options.dpi,
          preferDots: options.preferDots,
          maxBarHeightMm: Math.max(1, layout.barcode.barsMm),
          minBarHeightMm: minBar,
          thermal: profile.kind === "roll",
        }),
      );
    }
    return map;
  }, [rows, metrics, profile, layout, options.dpi, options.preferDots]);

  /**
   * How each stock would handle this run, for the size-card badges.
   *
   * Judged at each preset's OWN dpi and automatic bar width, because selecting
   * it is what `onPresetChange` applies. That also keeps the badges stable while
   * the merchant experiments in Advanced, instead of flickering under them.
   */
  const fitByPreset = useMemo(() => {
    const profiles = presetProfileMap();
    const summary = new Map<string, StockFitSummary>();
    for (const preset of LABEL_PRESETS) {
      const resolved = profiles.get(preset.id);
      if (!resolved) continue;
      let unfit = 0;
      let testScan = 0;
      for (const m of metrics.values()) {
        const verdict = classifyFit({
          metrics: m,
          availableMm: resolved.contentWidthMm,
          dpi: preset.defaultDpi,
          preferDots: "auto",
          thermal: resolved.kind === "roll",
        });
        if (verdict.fit === "unfit") unfit++;
        else if (verdict.needsTestScan) testScan++;
      }
      summary.set(preset.id, { unfit, testScan });
    }
    return summary;
  }, [metrics]);

  const printable = useMemo(() => {
    const out: LabelData[] = [];
    for (const l of rows) {
      if (!l.barcode) continue;
      const plan = plans.get(l.variantId);
      if (!plan || plan.quality === "unfit") continue; // surfaced as a warning instead
      const qty = quantities[l.variantId] ?? 1;
      for (let i = 0; i < qty && out.length < MAX_LABELS; i++) out.push(l);
    }
    return out;
  }, [rows, plans, quantities]);

  // What the merchant asked for, so truncation can be stated rather than silent.
  const requested = rows.reduce((n, l) => {
    if (!l.barcode) return n;
    const plan = plans.get(l.variantId);
    if (!plan || plan.quality === "unfit") return n;
    return n + (quantities[l.variantId] ?? 1);
  }, 0);
  const truncated = Math.max(0, requested - printable.length);

  const pages = useMemo(
    () => chunkPages(printable, profile.perPage, isSheet ? options.startOffset : 0),
    [printable, profile.perPage, isSheet, options.startOffset],
  );
  const pageIndex = Math.min(previewIndex, Math.max(0, pages.length - 1));

  // ── handlers ─────────────────────────────────────────────────────────────
  const patch = (p: Partial<LabelOptions>) => setOptions((o) => ({ ...o, ...p }));

  /**
   * Relative change, computed from the LIVE options rather than the render's
   * snapshot — so two clicks on a stepper inside one frame both land.
   */
  const step = (fn: (current: LabelOptions) => Partial<LabelOptions>) =>
    setOptions((o) => ({ ...o, ...fn(o) }));

  const selectPreset = (presetId: string) => {
    const preset = findPreset(presetId);
    setOptions((o) => ({
      ...o,
      presetId,
      // Rolls are 203 dpi thermal, A4 goes through a 600 dpi laser. Follow the
      // stock by default; the merchant can override afterwards.
      dpi: preset?.defaultDpi ?? o.dpi,
      // A dot count means a different width at a different dpi, so it cannot
      // survive the dpi change above.
      preferDots: "auto",
      startOffset: 0,
    }));
    setPreviewIndex(0);
    setIntroDismissed(true);
  };

  const selectFamily = (next: StockFamily) => {
    setFamily(next);
    setShowAll(false);
    selectPreset(defaultPresetFor(next));
  };

  const clampQty = (n: number) => Math.max(0, Math.min(MAX_QTY_PER_VARIANT, n));

  const setQuantity = (variantId: string, qty: number) =>
    setQuantities((q) => ({ ...q, [variantId]: clampQty(qty) }));

  const stepQuantity = (variantId: string, delta: number) =>
    setQuantities((q) => ({ ...q, [variantId]: clampQty((q[variantId] ?? 1) + delta) }));

  const setCustom = (p: Partial<CustomStock>) =>
    setOptions((o) => ({ ...o, custom: { ...o.custom, ...p } }));

  const toggleContent = (key: "showTitle" | "showSku" | "showPrice" | "showHri") =>
    setOptions((o) => ({ ...o, [key]: !o[key] }));

  /**
   * Mint a barcode for a variant that has none.
   *
   * Additive only, and only for variants with no barcode — the mutation's
   * default filter never touches an existing code. Replacing codes that already
   * exist lives on the Inventory screen behind a confirmation, because it
   * invalidates labels already stuck to boxes.
   */
  const missing = rows.filter((l) => !l.barcode);
  const generateFor = (ids: string[], marker: string) => {
    if (ids.length === 0) return;
    setGeneratingId(marker);
    generateBarcodes.mutate(
      { variantIds: ids },
      { onSettled: () => setGeneratingId(null) },
    );
  };

  // A merchant with a roll of stickers has no A4 sheets; keep suggestions to
  // stock they plausibly own. Custom has no family to stay inside.
  const suggestFamily = family === "custom" ? undefined : family;

  const suggestPreset = (variantId: string) => {
    const m = metrics.get(variantId);
    if (!m) return undefined;
    return findFittingPreset({
      metrics: m,
      minContentWidthMm: profile.contentWidthMm,
      family: suggestFamily,
    });
  };

  // ── warnings ─────────────────────────────────────────────────────────────
  const unfitRows = rows.filter(
    (l) => l.barcode && plans.get(l.variantId)?.quality === "unfit",
  );
  const noticeRows = rows.filter((l) => {
    const p = plans.get(l.variantId);
    return Boolean(l.barcode && p && p.quality !== "unfit" && p.notice);
  });

  const warnings: LabelWarning[] = [];

  if (unfitRows.length > 0) {
    const first = unfitRows[0]!;
    const m = metrics.get(first.variantId);
    const bigger = suggestPreset(first.variantId);
    warnings.push({
      id: "unfit",
      tone: "danger",
      title:
        unfitRows.length === 1
          ? "One barcode is too wide for this label"
          : `${unfitRows.length} barcodes are too wide for this label`,
      body: `${first.sku ?? first.barcode}${
        m ? ` — ${fitRemedy({ metrics: m, profile, family: suggestFamily })}` : ""
      } These labels are left out of the run.`,
      action: bigger
        ? {
            label: `Switch to ${bigger.widthMm} × ${bigger.heightMm} mm`,
            onClick: () => selectPreset(bigger.id),
          }
        : undefined,
    });
  }

  if (missing.length > 0) {
    warnings.push({
      id: "missing",
      tone: "warning",
      title:
        missing.length === 1
          ? "One product has no barcode"
          : `${missing.length} products have no barcode`,
      body: `${missing
        .map((m) => m.productTitle)
        .join(", ")} will be skipped until a barcode exists. Generating one takes a second and changes nothing else about the product.`,
      action: {
        label: `Generate ${missing.length} barcode${missing.length === 1 ? "" : "s"}`,
        pending: generatingId === "all-missing",
        onClick: () =>
          generateFor(
            missing.map((l) => l.variantId),
            "all-missing",
          ),
      },
    });
  }

  if (noticeRows.length > 0) {
    warnings.push({
      id: "notice",
      tone: "warning",
      title: "Test scan recommended",
      body: `${noticeRows
        .map((l) => l.sku ?? l.barcode)
        .join(", ")} print below the recommended bar width or magnification on ${
        profile.widthMm
      } × ${profile.heightMm} mm. Print one label, scan it, then run the batch.`,
    });
  }

  if (truncated > 0) {
    warnings.push({
      id: "truncated",
      tone: "warning",
      title: `Printing the first ${MAX_LABELS.toLocaleString()} labels`,
      body: `${requested.toLocaleString()} were requested. This run includes the first ${MAX_LABELS.toLocaleString()}; print the rest in a second run.`,
    });
  }

  // Custom stock is typed in by hand and each field is clamped on its own, so
  // "12 across at 300 mm" is accepted and then loses most of the sheet to
  // `overflow: hidden`. Presets are fixed geometry and never reach this.
  if (profile.overflowXMm > 0 || profile.overflowYMm > 0) {
    const over = [
      profile.overflowXMm > 0 ? `${profile.overflowXMm.toFixed(1)} mm too wide` : "",
      profile.overflowYMm > 0 ? `${profile.overflowYMm.toFixed(1)} mm too tall` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const fitsAcross = Math.max(
      1,
      Math.floor(
        (profile.pageWidthMm - profile.marginLeftMm + profile.gapXMm) /
          (profile.widthMm + profile.gapXMm),
      ),
    );
    warnings.push({
      id: "page-overflow",
      tone: "danger",
      title: "These labels don't fit the page",
      body: `The layout is ${over} for a ${profile.pageWidthMm} × ${profile.pageHeightMm} mm page. Anything past the edge is cut off, not wrapped. At ${profile.widthMm} mm wide, ${fitsAcross} fit across.`,
      action:
        profile.overflowXMm > 0 && fitsAcross !== profile.across
          ? {
              label: `Use ${fitsAcross} across`,
              onClick: () => setCustom({ across: fitsAcross }),
            }
          : undefined,
    });
  }

  if (isSheet && options.startOffset > 0) {
    warnings.push({
      id: "skip",
      tone: "info",
      title: `Skipping ${options.startOffset} used label${
        options.startOffset === 1 ? "" : "s"
      }`,
      body: "The first sheet starts printing after the gaps you marked as used. Feed that part-used sheet first.",
    });
  }

  if (options.nudgeXMm !== 0 || options.nudgeYMm !== 0) {
    warnings.push({
      id: "nudge",
      tone: "info",
      title: `Everything shifted ${options.nudgeXMm} mm across, ${options.nudgeYMm} mm down`,
      body: "A fine-positioning offset is active in Advanced print settings. Reset it if this printer is registered correctly.",
    });
  }

  // ── copy ─────────────────────────────────────────────────────────────────
  const total = printable.length;
  const pageWord = isSheet
    ? pages.length === 1
      ? "sheet"
      : "sheets"
    : pages.length === 1
      ? "row of roll"
      : "rows of roll";
  const readyNote =
    total === 0
      ? "Nothing to print yet — set a quantity above, or fix the warnings."
      : `${total.toLocaleString()} label${total === 1 ? "" : "s"} ready · ${pages.length} ${pageWord}`;

  const printSettings = [
    {
      key: "Paper size",
      value: isSheet
        ? "A4 (210 × 297 mm)"
        : `${profile.pageWidthMm.toFixed(0)} × ${profile.pageHeightMm.toFixed(0)} mm`,
    },
    { key: "Scale", value: "100% — not “Fit to page”" },
    { key: "Margins", value: "None" },
    { key: "Browser", value: "Chrome or Edge" },
  ];

  const familyPresets = presetsInFamily(family);
  const shownPresets = showAll ? familyPresets : familyPresets.filter((p) => p.common);
  const hiddenCount = familyPresets.length - shownPresets.length;

  const contentList = [
    options.showTitle && "product name",
    options.showSku && "SKU",
    options.showPrice && "price",
    options.showHri && "barcode number",
  ]
    .filter(Boolean)
    .join(" + ");
  const introSummary = `${profile.widthMm} × ${profile.heightMm} mm ${FAMILY_LABEL[family]}, ${contentList}, ${total} label${total === 1 ? "" : "s"} — one per unit in stock. Change anything below; we'll remember it on this device.`;


  // ── screen state ─────────────────────────────────────────────────────────
  const mode: "empty" | "error" | "loading" | "ready" =
    variantIds.length === 0
      ? "empty"
      : labels.isError && !labels.data
        ? "error"
        : labels.isLoading
          ? "loading"
          : "ready";

  return (
    <div className="min-h-screen bg-surface-sunken">
      <LabelPrintStyles profile={profile} />

      <div className="no-print mx-auto w-full max-w-screen-xl p-4 lg:p-6">
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h1 className="font-heading text-subhead text-foreground">
                Print product labels
              </h1>
              <p className="mt-0.5 text-body text-muted-foreground">
                Choose your label type, review the labels, and print when everything
                looks right.
              </p>
            </div>
            <div className="flex flex-none items-center gap-3">
              <span className="hidden text-caption text-muted-foreground sm:inline">
                Settings saved on this device
              </span>
              <Button asChild variant="outline" size="sm">
                <Link to="/products/inventory">
                  <ArrowLeft className="size-3.5" />
                  Back to inventory
                </Link>
              </Button>
            </div>
          </header>

          {mode === "empty" && (
            <StatusPanel
              title="No products selected"
              body="Go back to Inventory, tick the products you want labels for, then choose Print labels."
            >
              <Button asChild variant="accent" size="sm">
                <Link to="/products/inventory">Back to inventory</Link>
              </Button>
            </StatusPanel>
          )}

          {mode === "error" && (
            <StatusPanel
              title="We couldn't prepare the labels"
              body="Nothing was printed. Try again — your label settings are saved."
            >
              <Button variant="accent" size="sm" onClick={() => labels.refetch()}>
                <RefreshCw className="size-3.5" />
                Try again
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/products/inventory">Back to inventory</Link>
              </Button>
            </StatusPanel>
          )}

          {mode === "loading" && (
            <div className="grid place-items-center gap-3 px-6 py-24 text-center">
              <Skeleton className="h-26 w-52 rounded-md" />
              <p className="text-section text-foreground">Preparing your labels…</p>
              <p className="text-body text-muted-foreground">
                Reading barcodes for {variantIds.length} product
                {variantIds.length === 1 ? "" : "s"}.
              </p>
            </div>
          )}

          {mode === "ready" && (
            <div className="grid grid-cols-1 items-start lg:grid-cols-[minmax(0,1fr)_26.5rem]">
              {/* ── controls ─────────────────────────────────────────────── */}
              <div className="min-w-0 space-y-6 px-5 py-5">
                {!introDismissed && (
                  // `brand-strong` and `foreground`, not the fixed
                  // `brand-forest`: that token stays dark green in both themes
                  // (it is ink for paper and for lime fills), so on a dark
                  // surface it measures 1.1:1 — invisible.
                  <div className="rounded-xl border border-brand/40 bg-brand/10 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-label text-brand-strong">
                          First time here — we picked a setup for you
                        </p>
                        <p className="mt-1 text-caption leading-relaxed text-foreground/80">
                          {introSummary}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="xs"
                        className="flex-none"
                        onClick={() => setIntroDismissed(true)}
                      >
                        Looks right
                      </Button>
                    </div>
                  </div>
                )}

                <section className="space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-section text-foreground">
                      What are you printing on?
                    </h2>
                    <span className="text-caption text-muted-foreground">
                      {family === "custom"
                        ? "Enter your own measurements"
                        : `${familyPresets.length} sizes available`}
                    </span>
                  </div>

                  <StockFamilyTabs value={family} onChange={selectFamily} />

                  {family === "custom" ? (
                    <CustomStockFields custom={options.custom} onChange={setCustom} />
                  ) : (
                    <StockSizeGrid
                      presets={shownPresets}
                      hiddenCount={hiddenCount}
                      showAll={showAll}
                      onShowAllChange={setShowAll}
                      value={options.presetId}
                      onSelect={selectPreset}
                      fitByPreset={fitByPreset}
                      selectedHint={profile.hint}
                    />
                  )}
                </section>

                <section className="space-y-2">
                  <h2 className="text-section text-foreground">
                    What should appear on each label?
                  </h2>
                  <p className="text-caption text-muted-foreground">
                    {profile.printableWindows
                      ? "This tag has two small panels — the barcode prints on one, the text on the other. Hover a row to see where it lands."
                      : "Hover a row to see where it lands on the label."}
                  </p>
                  <LabelContentOptions
                    options={options}
                    onToggle={toggleContent}
                    onHover={setHover}
                    inWindow={Boolean(profile.printableWindows)}
                    anyHri={hriPossible}
                    currencyLabel={currency}
                  />
                </section>

                <section className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-section text-foreground">
                      How many labels do you need?
                    </h2>
                    <span className="text-caption text-muted-foreground">
                      Starts from stock on hand · up to {MAX_QTY_PER_VARIANT} per product
                    </span>
                  </div>
                  <LabelQuantityRows
                    rows={rows}
                    plans={plans}
                    profile={profile}
                    quantities={quantities}
                    onQuantityChange={setQuantity}
                    onQuantityStep={stepQuantity}
                    onGenerateBarcode={(id) => generateFor([id], id)}
                    generatingId={generatingId}
                    suggestPreset={suggestPreset}
                    onSelectPreset={selectPreset}
                  />
                </section>

                <AdvancedPrintSettings
                  options={options}
                  profile={profile}
                  defaultDpi={defaultDpi}
                  open={advancedOpen}
                  onOpenChange={setAdvancedOpen}
                  isCustomised={hasCustomAdvanced(options)}
                  onChange={patch}
                  onStep={step}
                  onReset={() =>
                    patch({
                      dpi: defaultDpi,
                      preferDots: "auto",
                      startOffset: 0,
                      nudgeXMm: 0,
                      nudgeYMm: 0,
                    })
                  }
                />
              </div>

              {/* ── rail ─────────────────────────────────────────────────── */}
              <aside className="space-y-4 border-t border-border bg-muted/30 px-5 py-5 lg:border-l lg:border-t-0">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-section text-foreground">Live preview</h2>
                  <span className="text-caption text-muted-foreground">
                    Updates automatically
                  </span>
                </div>

                <LabelPagePreview
                  pages={pages.length > 0 ? pages : [[]]}
                  index={pageIndex}
                  onIndexChange={setPreviewIndex}
                  profile={profile}
                  plans={plans}
                  options={options}
                  currency={currency}
                  hriPossible={hriPossible}
                  highlight={hover}
                />

                <PrintWarnings warnings={warnings} />
                <PrintSettingsCard settings={printSettings} />
                <PrintAction
                  total={total}
                  readyNote={readyNote}
                  onPrint={() => window.print()}
                />
              </aside>
            </div>
          )}
        </div>
      </div>

      {/*
        The print DOM. A DIRECT child of the route root and a sibling of the
        editor above — nothing between it and <body> carries padding, overflow,
        max-height or transform. Hidden on screen by `@media screen` in
        LabelPrintStyles; the rail shows its own scaled copy of one page.
      */}
      <LabelSheet
        pages={pages}
        profile={profile}
        plans={plans}
        options={options}
        currency={currency}
        hriPossible={hriPossible}
      />
    </div>
  );
}

function StatusPanel({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-2 px-6 py-24 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-muted">
        <Barcode className="size-5 text-muted-foreground" />
      </div>
      <p className="mt-1 text-section text-foreground">{title}</p>
      <p className="max-w-sm text-body leading-relaxed text-muted-foreground">{body}</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}
