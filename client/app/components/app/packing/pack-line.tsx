import { Check, Hand, MoreHorizontal, Package, TriangleAlert, Undo2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { canEnterCount, problemReasonLabel, productName } from "~/lib/packing";
import { cn } from "~/lib/utils";
import type { PackTaskLine } from "~/types/api";

export type LineAction = "confirm" | "count" | "problem" | "clear-problem" | "undo";

/**
 * One order line on the pack screen: photo (look-alikes are the usual mix-up),
 * name, variant, SKU, packed / required, and what was done by hand.
 */
export function PackLine({
  line,
  editable,
  flash,
  onAction,
}: {
  line: PackTaskLine;
  /** Only while the task is being packed. */
  editable: boolean;
  /** Just scanned: briefly highlighted so the eye finds it. */
  flash: boolean;
  onAction: (action: LineAction, line: PackTaskLine) => void;
}) {
  const full = line.packed >= line.required;
  const name = productName(line.title, line.variantTitle);
  const variant = line.variantTitle && line.variantTitle !== "Default Title" ? line.variantTitle : null;
  const meta = [variant, line.sku ? `SKU ${line.sku}` : null].filter(Boolean).join(" · ");

  return (
    <li
      className={cn(
        "flex gap-3 p-4 transition-colors duration-700",
        full && "bg-success-subtle/60",
        flash && "bg-brand/40",
      )}
      data-line-id={line.id}
    >
      {line.imageUrl ? (
        <img src={line.imageUrl} alt="" className="size-14 shrink-0 rounded-lg object-cover ring-1 ring-border md:size-16" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border md:size-16">
          <Package className="size-5" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="text-body font-medium [overflow-wrap:anywhere]">{line.title}</p>
        {meta && <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{meta}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {!line.scannable && <Chip className="bg-muted text-muted-foreground">No barcode</Chip>}
          {line.handConfirmed > 0 && (
            <Chip className="bg-info-subtle text-info">
              <Hand className="size-3" /> {line.handConfirmed} by hand
            </Chip>
          )}
          {line.counted > 0 && <Chip className="bg-info-subtle text-info">{line.counted} counted</Chip>}
          {line.problem && (
            <Chip className="bg-danger-subtle text-danger">
              <TriangleAlert className="size-3" /> {problemReasonLabel(line.problem.reason)}: {line.problem.qty}
            </Chip>
          )}
        </div>
        {editable && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!line.scannable && !full && (
              <Button variant="outline" size="sm" className="h-9 md:h-7" onClick={() => onAction("confirm", line)}>
                <Hand /> Confirm by hand
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-9 text-muted-foreground md:h-7" aria-label={`More for ${name}`}>
                  <MoreHorizontal /> More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {line.scannable && !full && (
                  <DropdownMenuItem onSelect={() => onAction("confirm", line)}>
                    <Hand /> Confirm by hand
                  </DropdownMenuItem>
                )}
                {canEnterCount(line) && (
                  <DropdownMenuItem onSelect={() => onAction("count", line)}>Enter the count</DropdownMenuItem>
                )}
                {line.problem ? (
                  <DropdownMenuItem onSelect={() => onAction("clear-problem", line)}>
                    <TriangleAlert /> Clear the problem
                  </DropdownMenuItem>
                ) : (
                  !full && (
                    <DropdownMenuItem onSelect={() => onAction("problem", line)}>
                      <TriangleAlert /> Report a problem
                    </DropdownMenuItem>
                  )
                )}
                <DropdownMenuItem disabled={line.packed === 0} onSelect={() => onAction("undo", line)}>
                  <Undo2 /> Take one out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="text-subhead tabular-nums" aria-label={`${line.packed} of ${line.required} packed`}>
          {line.packed}
          <span className="text-muted-foreground">/{line.required}</span>
        </span>
        {full && (
          <span className="flex items-center gap-1 text-caption font-medium text-success">
            <Check className="size-3.5" /> Packed
          </span>
        )}
      </div>
    </li>
  );
}

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-micro font-medium", className)}>
      {children}
    </span>
  );
}
