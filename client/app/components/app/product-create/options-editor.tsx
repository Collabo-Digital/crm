import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ProductOption } from "~/types/api";

function parseValues(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Editor for the product's option types (Size, Color, Material).
 *
 * Up to 3 option types can be defined. Each option has a name (e.g. "Size")
 * and a list of values entered as comma-separated text (e.g. "S, M, L").
 *
 * The parent owns the `options` state; this is a controlled component.
 */
export function OptionsEditor({
  options,
  onChange,
}: {
  options: ProductOption[];
  onChange: (next: ProductOption[]) => void;
}) {
  // What the user is TYPING in each values box, kept separately from the
  // parsed array the parent owns. Rendering `values.join(", ")` straight
  // back into a controlled input meant every keystroke was parsed and
  // re-serialised — "S," became "S" before the next character arrived, so a
  // comma could never be typed and "S, M" turned into "SM". The buffer is
  // dropped on blur, at which point the box shows the normalised list.
  const [valueDrafts, setValueDrafts] = useState<Record<number, string>>({});

  function patchOption(idx: number, patch: Partial<ProductOption>) {
    onChange(options.map((o, i) => (i === idx ? { ...o, ...patch } : o)));
  }

  function addOption() {
    if (options.length >= 3) return;
    onChange([
      ...options,
      { name: "", values: [], position: options.length + 1 },
    ]);
  }

  function removeOption(idx: number) {
    // Indexes shift; drop every draft rather than re-key them.
    setValueDrafts({});
    onChange(
      options
        .filter((_, i) => i !== idx)
        .map((o, i) => ({ ...o, position: i + 1 })),
    );
  }

  return (
    <div className="space-y-2">
      {options.map((opt, idx) => (
        <div
          key={idx}
          className="rounded-lg border border-input bg-gray-50 dark:bg-gray-800/40 p-3"
        >
          <div className="flex items-center gap-2">
            <input
              value={opt.name}
              onChange={(e) => patchOption(idx, { name: e.target.value })}
              placeholder="Option name (e.g. Size)"
              className="h-8 flex-1 rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <button
              type="button"
              onClick={() => removeOption(idx)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-red-600"
              title="Remove option"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
          <input
            value={valueDrafts[idx] ?? opt.values.join(", ")}
            onChange={(e) => {
              const raw = e.target.value;
              setValueDrafts((prev) => ({ ...prev, [idx]: raw }));
              patchOption(idx, { values: parseValues(raw) });
            }}
            onBlur={() =>
              setValueDrafts((prev) => {
                const next = { ...prev };
                delete next[idx];
                return next;
              })
            }
            placeholder="Values, comma-separated (e.g. Small, Medium, Large)"
            className="mt-2 h-8 w-full rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
        </div>
      ))}

      {options.length < 3 && (
        <button
          type="button"
          onClick={addOption}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-input bg-white dark:bg-gray-900 px-3 py-1.5 text-xs text-muted-foreground hover:bg-gray-50 dark:hover:bg-gray-800/60"
        >
          <Plus className="size-3.5" />
          Add option
        </button>
      )}
    </div>
  );
}
