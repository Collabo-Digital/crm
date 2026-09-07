import { AlertTriangle, Plus, X } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { plural } from "~/lib/variant-grouping";
import type { EditableOption } from "~/lib/product-options";

/**
 * One `OPTION N` block: the thing that changes, and the choices it can take.
 */
export function VariantOptionRow({
  index,
  option,
  valueDraft,
  isRenamed,
  canRemove,
  removeBlockedReason,
  onNameChange,
  onValueDraftChange,
  onAddValue,
  onRemoveValue,
  onRemove,
}: {
  /** 0-based; rendered as "OPTION 1". */
  index: number;
  option: EditableOption;
  valueDraft: string;
  /** The name differs from the one the server has — see the card's warning. */
  isRenamed: boolean;
  canRemove: boolean;
  removeBlockedReason?: string;
  onNameChange: (name: string) => void;
  onValueDraftChange: (value: string) => void;
  onAddValue: () => void;
  onRemoveValue: (valueIndex: number) => void;
  onRemove: () => void;
}) {
  const nameId = `option-name-${option.uid}`;
  const valueId = `option-value-${option.uid}`;

  return (
    <div className="rounded-lg ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <label
          htmlFor={nameId}
          className="w-16 shrink-0 text-micro uppercase tracking-wider text-muted-foreground"
        >
          Option {index + 1}
        </label>
        <Input
          id={nameId}
          value={option.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Color"
          aria-invalid={isRenamed || undefined}
          className="h-8 max-w-56 flex-1"
        />
        <span className="ml-auto text-caption text-muted-foreground">
          {plural(option.values.length, "value")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? undefined : removeBlockedReason}
          className="text-caption text-muted-foreground hover:text-danger"
        >
          Remove
        </Button>
      </div>

      {isRenamed && (
        <p className="flex items-start gap-1.5 px-4 pb-2 text-caption text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Renaming clears this option&apos;s value on every existing variant.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <label
          htmlFor={valueId}
          className="w-16 shrink-0 text-micro uppercase tracking-wider text-muted-foreground"
        >
          Choose
        </label>
        {option.values.map((value, valueIndex) => (
          <Badge key={`${value}-${valueIndex}`} variant="outline" className="gap-1">
            {value}
            <button
              type="button"
              onClick={() => onRemoveValue(valueIndex)}
              className="rounded-sm text-muted-foreground hover:text-danger"
              aria-label={`Remove ${value}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          id={valueId}
          value={valueDraft}
          onChange={(e) => onValueDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAddValue();
            }
          }}
          placeholder="Add another choice"
          className="h-7 w-44"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAddValue}
          disabled={!valueDraft.trim()}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}
