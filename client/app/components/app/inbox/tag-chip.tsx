import { X } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A contact tag. Tags are free text the team types, so they share one
 * neutral style; colour is kept for states (opted out, blocked) that mean
 * something on their own.
 */
export function TagChip({
  tag,
  onRemove,
  className,
}: {
  tag: string;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{tag}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Remove tag ${tag}`}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
