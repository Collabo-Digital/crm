import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { EditableOption } from "~/lib/product-options";
import { combinationSummary, pendingCombinationCount, plural } from "~/lib/variant-grouping";
import type { ProductVariant } from "~/types/api";
import { VariantOptionRow } from "./variant-option-row";

/**
 * Which options were renamed rather than reordered.
 *
 * The server matches options by exact name, so a rename is a delete + create:
 * every existing variant has its value for that option cleared, and the Shopify
 * push issues a destructive `productOptionsDelete`. A *reorder* keeps both names
 * present in the set, which is why a name still found elsewhere isn't a rename.
 */
function detectRenames(
  options: EditableOption[],
  committedNames: string[],
): Array<{ from: string; to: string }> {
  const currentNames = options.map((o) => o.name.trim()).filter(Boolean);
  const renames: Array<{ from: string; to: string }> = [];
  options.forEach((option, index) => {
    const was = committedNames[index];
    const now = option.name.trim();
    if (!was || !now || was === now) return;
    if (currentNames.includes(was)) return;
    renames.push({ from: was, to: now });
  });
  return renames;
}

export function VariantOptionsCard({
  options,
  valueDrafts,
  committedOptionNames,
  variants,
  isDirty,
  isSaving,
  isSyncedToShopify,
  onAddOption,
  onRemoveOption,
  onOptionNameChange,
  onValueDraftChange,
  onAddValue,
  onRemoveValue,
  onSaveAndGenerate,
}: {
  options: EditableOption[];
  valueDrafts: string[];
  /** Option names as the server currently has them, positionally. */
  committedOptionNames: string[];
  variants: ProductVariant[];
  isDirty: boolean;
  isSaving: boolean;
  isSyncedToShopify: boolean;
  onAddOption: () => void;
  onRemoveOption: (index: number) => void;
  onOptionNameChange: (index: number, name: string) => void;
  onValueDraftChange: (index: number, value: string) => void;
  onAddValue: (index: number) => void;
  onRemoveValue: (optionIndex: number, valueIndex: number) => void;
  onSaveAndGenerate: () => void;
}) {
  const [confirmRenames, setConfirmRenames] = useState(false);

  const summary = useMemo(() => combinationSummary(options), [options]);
  const pending = useMemo(
    () => pendingCombinationCount(options, variants),
    [options, variants],
  );
  const renames = useMemo(
    () => detectRenames(options, committedOptionNames),
    [options, committedOptionNames],
  );

  const hasIncompleteOption = options.some(
    (o) => !o.name.trim() || o.values.length === 0,
  );
  const duplicateNames =
    new Set(options.map((o) => o.name.trim()).filter(Boolean)).size !==
    options.filter((o) => o.name.trim()).length;

  const canSubmit =
    !isSaving &&
    options.length > 0 &&
    !hasIncompleteOption &&
    !duplicateNames &&
    (isDirty || pending > 0);

  const label = isDirty
    ? "Save and generate"
    : pending > 0
      ? `Generate ${plural(pending, "variant")}`
      : "Everything is generated";

  function submit() {
    if (renames.length > 0) {
      setConfirmRenames(true);
      return;
    }
    onSaveAndGenerate();
  }

  return (
    <SectionCard
      title="What makes your variants different?"
      description="Name the thing that changes, then list its choices. Two options give you one variant for every combination."
      icon={
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-micro font-semibold text-brand-foreground">
          1
        </span>
      }
    >
      <div className="space-y-3 px-5 py-4">
        {options.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            No options yet. Add Size, Color, or Material to start building variants.
          </p>
        ) : (
          options.map((option, index) => (
            <VariantOptionRow
              key={option.uid}
              index={index}
              option={option}
              valueDraft={valueDrafts[index] ?? ""}
              isRenamed={renames.some((r) => r.to === option.name.trim())}
              // The server refuses to drop the last option while more than one
              // variant exists — say so here instead of failing the request.
              canRemove={options.length > 1 || variants.length <= 1}
              removeBlockedReason="Delete variants down to one before removing the last option."
              onNameChange={(name) => onOptionNameChange(index, name)}
              onValueDraftChange={(value) => onValueDraftChange(index, value)}
              onAddValue={() => onAddValue(index)}
              onRemoveValue={(valueIndex) => onRemoveValue(index, valueIndex)}
              onRemove={() => onRemoveOption(index)}
            />
          ))
        )}

        {options.length < 3 && (
          <Button type="button" variant="outline" size="sm" onClick={onAddOption}>
            <Plus className="size-3.5" />
            Add another option
          </Button>
        )}

        {duplicateNames && (
          <p className="text-caption text-danger">
            Two options can&apos;t share a name.
          </p>
        )}

        {renames.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2.5 text-caption text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {renames.map((r) => `“${r.from}” → “${r.to}”`).join(", ")} is a rename,
              not an edit. Saving clears that option&apos;s value on all{" "}
              {plural(variants.length, "variant")} and regenerates them
              {isSyncedToShopify ? ", and deletes the option on Shopify" : ""}.
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
        <p className="text-caption text-muted-foreground">
          {summary.parts.length === 0 ? (
            "Add an option with at least one choice to build variants."
          ) : (
            <>
              {summary.parts
                .map((part) => plural(part.count, part.name.toLowerCase()))
                .join(" × ")}{" "}
              = {plural(summary.total, "variant")}
              {pending > 0 && ` · ${pending} new`}
            </>
          )}
        </p>
        <Button type="button" variant="accent" onClick={submit} disabled={!canSubmit}>
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          {label}
        </Button>
      </div>

      <Dialog open={confirmRenames} onOpenChange={setConfirmRenames}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename this option?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-caption">
            <ul className="space-y-1">
              {renames.map((r) => (
                <li key={r.from} className="font-medium text-foreground">
                  {r.from} → {r.to}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Options are matched by name, so this is a delete and re-create, not
              an edit. All {plural(variants.length, "variant")} lose their value for
              this option and are regenerated from the new name — prices, SKUs and
              stock stay on the rows they are already on.
            </p>
            {isSyncedToShopify && (
              <p className="text-warning">
                This product is synced to Shopify. The next push deletes the old
                option there and creates the new one.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmRenames(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              onClick={() => {
                setConfirmRenames(false);
                onSaveAndGenerate();
              }}
            >
              Rename and regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
