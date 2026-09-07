import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { isColourOption, swatchTint } from "~/lib/variant-grouping";

/**
 * The little tile beside a variant group's name.
 *
 * There is no colour column on a variant — option values are plain strings — so
 * this resolves in three steps, best evidence first:
 *
 *   1. the variant's linked image, when one is set;
 *   2. the value read as a literal CSS colour, but only when the option is
 *      actually named Color/Shade (see `isColourOption`);
 *   3. a deterministic token tint with the value's initial.
 */
export function VariantSwatch({
  value,
  optionName,
  imageSrc,
  className,
}: {
  value: string;
  optionName?: string | null;
  imageSrc?: string | null;
  className?: string;
}) {
  // Resolved after mount, never during render: CSS.supports doesn't exist on
  // the server, and branching on it inline would make the first client render
  // disagree with the server's HTML.
  const [cssColour, setCssColour] = useState<string | null>(null);

  useEffect(() => {
    if (!isColourOption(optionName)) {
      setCssColour(null);
      return;
    }
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return;
    const candidate = value.trim().toLowerCase().replace(/\s+/g, "");
    setCssColour(CSS.supports("color", candidate) ? candidate : null);
  }, [value, optionName]);

  const base = "size-6 shrink-0 rounded-md ring-1 ring-border";

  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt=""
        aria-hidden
        title={value}
        className={cn(base, "object-cover", className)}
      />
    );
  }

  if (cssColour) {
    return (
      <span
        aria-hidden
        title={value}
        className={cn(base, className)}
        // Merchant data, not a design decision — the one thing a token can't
        // express. Leave this alone in any token migration pass.
        style={{ backgroundColor: cssColour }}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={value}
      className={cn(
        base,
        "flex items-center justify-center text-micro font-semibold uppercase",
        swatchTint(value),
        className,
      )}
    >
      {value.trim().charAt(0) || "?"}
    </span>
  );
}
