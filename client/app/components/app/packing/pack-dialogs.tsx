import { useState } from "react";
import { Info, Loader2, Minus, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { RadioCard, RadioGroup } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import {
  CONFIRM_REASONS,
  HOLD_REASONS,
  PROBLEM_REASONS,
  itemsWord,
  productName,
  scannedUnits,
  type FinishOptions,
} from "~/lib/packing";
import { cn } from "~/lib/utils";
import type { PackConfirmReason, PackHoldReason, PackProblemReason, PackTaskLine } from "~/types/api";

const fieldLabel = "text-label text-foreground";

function QtyStepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <Button type="button" variant="outline" size="icon-lg" aria-label="One fewer" disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus />
      </Button>
      <span className="min-w-10 text-center text-subhead tabular-nums" aria-live="polite">
        {value}
      </span>
      <Button type="button" variant="outline" size="icon-lg" aria-label="One more" disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus />
      </Button>
      <span className="text-caption text-muted-foreground">of {max}</span>
    </div>
  );
}

function Footer({
  onCancel,
  confirmLabel,
  pending,
  disabled,
  tone = "accent",
}: {
  onCancel: () => void;
  confirmLabel: string;
  pending: boolean;
  disabled?: boolean;
  tone?: "accent" | "destructive";
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button type="submit" variant={tone} disabled={pending || disabled}>
        {pending && <Loader2 className="animate-spin" />}
        {confirmLabel}
      </Button>
    </DialogFooter>
  );
}

export type LineDialogMode = "confirm" | "count" | "problem";

/** Confirm by hand, enter a count, or report a problem on one line. */
export function LineDialog({
  mode,
  line,
  pending,
  onClose,
  onConfirm,
  onCount,
  onProblem,
}: {
  mode: LineDialogMode;
  line: PackTaskLine;
  pending: boolean;
  onClose: () => void;
  onConfirm: (qty: number, reason: PackConfirmReason) => void;
  onCount: (packed: number) => void;
  onProblem: (reason: PackProblemReason, qty: number) => void;
}) {
  const remaining = Math.max(0, line.required - line.packed);
  const name = productName(line.title, line.variantTitle);
  const [qty, setQty] = useState(1);
  const [confirmReason, setConfirmReason] = useState<PackConfirmReason | "">(line.scannable ? "" : "no_barcode");
  const [problemReason, setProblemReason] = useState<PackProblemReason | "">("");
  // A count can't go below what was scanned or confirmed by hand: those were seen.
  const countMin = line.packed - line.counted;
  const [countText, setCountText] = useState(String(line.packed));
  const count = Number(countText);
  const countValid = countText.trim() !== "" && Number.isInteger(count) && count >= countMin && count <= line.required;

  const title = mode === "confirm" ? "Confirm by hand" : mode === "count" ? "Enter the count" : "Report a problem";
  const description =
    mode === "count"
      ? `Count the ${name} going into the parcel and type the total. ${scannedUnits(line)} scanned so far.`
      : `${name}. ${remaining} still to pack.`;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "confirm" && confirmReason) onConfirm(qty, confirmReason);
            if (mode === "count" && countValid) onCount(count);
            if (mode === "problem" && problemReason) onProblem(problemReason, qty);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {mode === "count" ? (
            <div className="space-y-1.5">
              <label htmlFor="pack-count" className={fieldLabel}>
                Packed in total
              </label>
              <Input
                id="pack-count"
                type="number"
                inputMode="numeric"
                min={countMin}
                max={line.required}
                value={countText}
                onChange={(e) => setCountText(e.target.value)}
                autoFocus
                className="h-11 max-w-40 text-section tabular-nums"
              />
              <p className="text-caption text-muted-foreground">
                Between {countMin} and {line.required}.
              </p>
            </div>
          ) : (
            <>
              {mode === "problem" && (
                <fieldset className="space-y-2">
                  <legend className={cn(fieldLabel, "mb-2")}>What's wrong?</legend>
                  <RadioGroup value={problemReason} onValueChange={(v) => setProblemReason(v as PackProblemReason)}>
                    {PROBLEM_REASONS.map((r) => (
                      <RadioCard key={r.value} id={`problem-${r.value}`} value={r.value} className="p-3">
                        <span className="text-body text-foreground">{r.label}</span>
                      </RadioCard>
                    ))}
                  </RadioGroup>
                </fieldset>
              )}
              {remaining > 1 && (
                <div className="space-y-2">
                  <p className={fieldLabel}>How many?</p>
                  <QtyStepper value={qty} min={1} max={remaining} onChange={setQty} label="How many" />
                </div>
              )}
              {mode === "confirm" && (
                <fieldset className="space-y-2">
                  <legend className={cn(fieldLabel, "mb-2")}>Why not scan it?</legend>
                  <RadioGroup value={confirmReason} onValueChange={(v) => setConfirmReason(v as PackConfirmReason)}>
                    {CONFIRM_REASONS.map((r) => (
                      <RadioCard key={r.value} id={`confirm-${r.value}`} value={r.value} className="p-3">
                        <span className="text-body text-foreground">{r.label}</span>
                      </RadioCard>
                    ))}
                  </RadioGroup>
                  <p className="text-caption text-muted-foreground">Items confirmed by hand show on the accuracy report.</p>
                </fieldset>
              )}
            </>
          )}

          <Footer
            onCancel={onClose}
            pending={pending}
            confirmLabel={mode === "confirm" ? `Confirm ${qty}` : mode === "count" ? "Save the count" : "Report it"}
            disabled={mode === "confirm" ? !confirmReason : mode === "count" ? !countValid : !problemReason}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The short-items sheet, or a plain hold. Holding the whole order is the
 * default; sending part of it is offered only when `options.canPartial`.
 */
export function FinishDialog({
  mode,
  options,
  shortLines,
  pending,
  onClose,
  onHold,
  onPartial,
}: {
  mode: "short" | "hold";
  options: FinishOptions;
  shortLines: PackTaskLine[];
  pending: boolean;
  onClose: () => void;
  onHold: (reason: PackHoldReason, note?: string) => void;
  onPartial: () => void;
}) {
  const [choice, setChoice] = useState<"hold" | "partial">("hold");
  const [reason, setReason] = useState<PackHoldReason | null>(mode === "short" ? "items_short" : null);
  const [note, setNote] = useState("");
  const short = options.requiredUnits - options.packedUnits;
  const partial = mode === "short" && choice === "partial" && options.canPartial;

  const holdFields = (
    <div className="space-y-3">
      <div className="space-y-2">
        <p className={fieldLabel}>Reason</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason for the hold">
          {HOLD_REASONS.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={reason === r.value}
              onClick={() => setReason(r.value)}
              className={cn(
                "min-h-11 rounded-full border px-3 text-label md:min-h-8",
                reason === r.value ? "border-ink bg-ink text-brand" : "border-border text-foreground hover:bg-muted",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="hold-note" className={fieldLabel}>
          Note <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="hold-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="For example: 2 blue kurtas expected Thursday"
        />
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (partial) onPartial();
            else if (reason) onHold(reason, note.trim() || undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {mode === "short" ? `${itemsWord(short)} not packed yet` : "Put this order on hold"}
            </DialogTitle>
            <DialogDescription>
              {mode === "short"
                ? `${options.packedUnits} of ${itemsWord(options.requiredUnits)} are in the parcel.`
                : "It moves to On hold until someone resumes it. Nothing packed so far is lost."}
            </DialogDescription>
          </DialogHeader>

          {mode === "short" && shortLines.length > 0 && (
            <ul className="divide-y rounded-lg bg-muted/50 text-body">
              {shortLines.map((l) => (
                <li key={l.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{productName(l.title, l.variantTitle)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {l.packed} of {l.required}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {mode === "short" ? (
            <RadioGroup value={choice} onValueChange={(v) => setChoice(v as "hold" | "partial")}>
              <RadioCard id="finish-hold" value="hold" className="p-3">
                <p className="text-label font-semibold text-foreground">Hold the order</p>
                <p className="text-caption text-muted-foreground">Keep the parcel aside until the rest is found.</p>
              </RadioCard>
              {options.canPartial && (
                <RadioCard id="finish-partial" value="partial" className="p-3">
                  <p className="text-label font-semibold text-foreground">Mark these packed, pack the rest later</p>
                  <p className="text-caption text-muted-foreground">
                    {options.packedUnits} of {itemsWord(options.requiredUnits)} go out now. The rest are packed after this parcel ships.
                  </p>
                </RadioCard>
              )}
            </RadioGroup>
          ) : null}

          {mode === "short" && options.partialNote && (
            <p className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-caption text-info">
              <Info className="mt-px size-3.5 shrink-0" />
              <span>{options.partialNote}</span>
            </p>
          )}

          {!partial && holdFields}

          <Footer
            onCancel={onClose}
            pending={pending}
            confirmLabel={partial ? `Mark ${options.packedUnits} packed` : "Put on hold"}
            disabled={!partial && !reason}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StartOverDialog({
  packedUnits,
  pending,
  onClose,
  onConfirm,
}: {
  packedUnits: number;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start over?</DialogTitle>
            <DialogDescription>
              {packedUnits > 0
                ? `This clears the ${itemsWord(packedUnits)} packed so far. Take them out of the parcel and scan everything again.`
                : "This clears any problems and holds on this order and starts it fresh."}
            </DialogDescription>
          </DialogHeader>
          <Footer onCancel={onClose} pending={pending} confirmLabel="Start over" tone="destructive" />
        </form>
      </DialogContent>
    </Dialog>
  );
}
