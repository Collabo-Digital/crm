/**
 * "How many labels do you need?" — one row per variant.
 *
 * Rows that cannot print say why and offer the fix, rather than showing a dead
 * chip with the remedy buried in a `title`. The two fixes are deliberately
 * additive: generating a barcode for a variant that has none, and switching to
 * wider stock. Nothing on this screen ever overwrites a barcode that exists —
 * that lives on the Inventory screen, behind a confirmation, because it
 * invalidates labels already stuck to boxes.
 */
import { Loader2, Minus, Plus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "~/components/ui/input-group";
import type { BarcodePlan } from "~/lib/barcode";
import { MAX_QTY_PER_VARIANT } from "~/lib/label-options";
import type { LabelPreset, ResolvedProfile } from "~/lib/label-stock";
import { cn } from "~/lib/utils";
import type { LabelData } from "~/types/api";

export function LabelQuantityRows({
  rows,
  plans,
  profile,
  quantities,
  onQuantityChange,
  onQuantityStep,
  onGenerateBarcode,
  generatingId,
  suggestPreset,
  onSelectPreset,
}: {
  rows: LabelData[];
  plans: Map<string, BarcodePlan>;
  profile: ResolvedProfile;
  quantities: Record<string, number>;
  /** Absolute, for the text field. */
  onQuantityChange: (variantId: string, qty: number) => void;
  /**
   * Relative, for the −/+ buttons. Deliberately a delta rather than
   * `onQuantityChange(id, qty + 1)`: `qty` comes from the last render, so two
   * clicks landing in one frame would both compute from the same number and
   * one would be lost.
   */
  onQuantityStep: (variantId: string, delta: number) => void;
  onGenerateBarcode: (variantId: string) => void;
  /** Variant whose barcode is being minted right now, if any. */
  generatingId: string | null;
  suggestPreset: (variantId: string) => LabelPreset | undefined;
  onSelectPreset: (presetId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {rows.map((l, i) => {
        const plan = plans.get(l.variantId);
        const unfit = Boolean(l.barcode) && plan?.quality === "unfit";
        const blocked = !l.barcode || unfit;
        const bigger = unfit ? suggestPreset(l.variantId) : undefined;
        const qty = quantities[l.variantId] ?? 1;

        return (
          <div
            key={l.variantId}
            className={cn(
              "flex flex-wrap items-center gap-3 px-3 py-2.5",
              i < rows.length - 1 && "border-b border-border",
              blocked && "bg-muted/40",
            )}
          >
            <div className="min-w-[11rem] flex-1">
              <div className="truncate text-label text-foreground">
                {l.productTitle}
                {l.variantTitle !== "Default Title" ? ` — ${l.variantTitle}` : ""}
              </div>
              <div className="truncate font-mono text-caption text-muted-foreground">
                {l.sku ?? "no SKU"}
                {" · "}
                {l.barcode ? `${l.defaultQty} in stock` : "no barcode"}
              </div>
            </div>

            {blocked ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  className={cn(
                    !l.barcode
                      ? "bg-warning-subtle text-warning-strong"
                      : "bg-danger-subtle text-danger",
                  )}
                >
                  {!l.barcode
                    ? "No barcode"
                    : `Too wide for ${profile.widthMm} × ${profile.heightMm} mm`}
                </Badge>
                {!l.barcode ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={generatingId !== null}
                    onClick={() => onGenerateBarcode(l.variantId)}
                  >
                    {generatingId === l.variantId && (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    Create barcode
                  </Button>
                ) : bigger ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onSelectPreset(bigger.id)}
                  >
                    Use {bigger.widthMm} × {bigger.heightMm} mm
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {plan?.notice && (
                  <Badge
                    className="bg-warning-subtle text-warning-strong"
                    title={plan.notice}
                  >
                    Test scan
                  </Badge>
                )}
                <InputGroup className="w-30">
                  <InputGroupAddon align="inline-start">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="One fewer"
                      disabled={qty <= 0}
                      onClick={() => onQuantityStep(l.variantId, -1)}
                    >
                      <Minus />
                    </InputGroupButton>
                  </InputGroupAddon>
                  <InputGroupInput
                    inputMode="numeric"
                    aria-label={`Labels for ${l.productTitle}`}
                    value={qty}
                    onChange={(e) =>
                      onQuantityChange(
                        l.variantId,
                        parseInt(e.target.value, 10) || 0,
                      )
                    }
                    className="text-center tabular-nums"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="One more"
                      disabled={qty >= MAX_QTY_PER_VARIANT}
                      onClick={() => onQuantityStep(l.variantId, 1)}
                    >
                      <Plus />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
