import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarDays, Check, ChevronDown, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMediaQuery } from "~/hooks/use-media-query";
import type { CustomDateRange, DateRangePreset } from "~/hooks/use-date-range-filter";
import { cn } from "~/lib/utils";

/**
 * `YYYY-MM-DD` ↔ local-midnight Date. The calendar reads only the date parts,
 * so the browser's own zone can never shift the day that is sent.
 */
function toDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function toDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const optionClass =
  "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-caption hover:bg-accent focus-visible:bg-accent focus-visible:outline-none max-md:min-h-11 max-md:text-label pointer-coarse:min-h-11";

/**
 * Date filter for a page header: the page's presets plus a custom from/to.
 *
 * A preset applies on click. A custom range is a draft until Apply, so
 * half-picking a range never refetches the page.
 */
export function DateRangeFilter<T extends string>({
  presets,
  preset,
  custom,
  label,
  today,
  onPresetChange,
  onCustomApply,
  className,
  variant = "button",
  active = false,
  onClear,
}: {
  presets: ReadonlyArray<DateRangePreset<T>>;
  preset: T;
  custom: CustomDateRange | null;
  label: string;
  /** `YYYY-MM-DD` in the reporting zone; later days cannot be picked. */
  today: string;
  onPresetChange: (value: T) => void;
  onCustomApply: (range: CustomDateRange) => void;
  className?: string;
  /**
   * "button" — the page-header control (dashboard, customer detail).
   * "chip" — the DataTable filter-row chip: "Date: <label>", tinted while a
   * range other than the page's default is applied, with a × that calls
   * `onClear`. Same popover either way.
   */
  variant?: "button" | "chip";
  /** Chip only: whether a non-default range is applied (tint + clear button). */
  active?: boolean;
  /** Chip only: resets to the page's default range. */
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  // Two months side by side are ~560px wide; a phone gets one.
  const twoMonths = useMediaQuery("(min-width: 640px)");
  const todayDate = toDate(today);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Reopen on what is applied, not on an abandoned draft.
    setShowCalendar(custom !== null);
    setDraft(custom ? { from: toDate(custom.from), to: toDate(custom.to) } : undefined);
  }

  function apply() {
    if (!draft?.from) return;
    // One click is a one-day range.
    onCustomApply({ from: toDay(draft.from), to: toDay(draft.to ?? draft.from) });
    setOpen(false);
  }

  const trigger =
    variant === "chip" ? (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 items-center gap-1.5 whitespace-nowrap rounded-full bg-transparent pl-3 pr-2 text-label focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-7 md:pl-2.5 pointer-coarse:h-11"
      >
        <CalendarDays className="size-3.5" />
        <span className="font-medium">Date:</span>
        <span>{label}</span>
        {!active && <ChevronDown className="size-3 text-muted-foreground" />}
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg border border-input bg-card px-2.5 text-caption font-medium whitespace-nowrap shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:text-label pointer-coarse:h-11",
          className,
        )}
      >
        <CalendarDays className="size-3.5 text-muted-foreground" />
        <span>{label}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
    );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {variant === "chip" ? (
        // The chip is one pill holding the trigger and, while a range is
        // applied, a separate clear button — never a button inside a button.
        <div
          className={cn(
            "inline-flex h-11 shrink-0 items-center rounded-full text-label md:h-7 pointer-coarse:h-11",
            active ? "bg-brand/30 text-brand-strong" : "bg-card text-foreground ring-1 ring-border",
            className,
          )}
        >
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          {active && onClear && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear date range"
              title="Clear date range"
              className="flex size-11 items-center justify-center rounded-full hover:bg-brand-strong/10 md:mr-0.5 md:size-6 pointer-coarse:mr-0 pointer-coarse:size-11"
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          )}
        </div>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        align={variant === "chip" ? "start" : "end"}
        className="w-auto max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col sm:flex-row">
          <ul className="flex flex-col gap-0.5 border-border p-1 sm:w-36 sm:border-r">
            {presets.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  className={optionClass}
                  onClick={() => {
                    onPresetChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                  {!custom && preset === option.value && <Check className="size-3.5" />}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={cn(optionClass, showCalendar && "bg-accent")}
                onClick={() => setShowCalendar(true)}
              >
                Custom range
                {custom && <Check className="size-3.5" />}
              </button>
            </li>
          </ul>
          {showCalendar && (
            <div className="border-t border-border p-2 sm:border-t-0">
              <Calendar
                mode="range"
                selected={draft}
                onSelect={setDraft}
                resetOnSelect
                numberOfMonths={twoMonths ? 2 : 1}
                // Side by side, a month's trailing days repeat the next
                // month's first ones, so one date shows up twice.
                showOutsideDays={!twoMonths}
                // Two months end on the current one rather than starting on it.
                defaultMonth={
                  draft?.from ??
                  new Date(todayDate.getFullYear(), todayDate.getMonth() - (twoMonths ? 1 : 0), 1)
                }
                endMonth={todayDate}
                disabled={{ after: todayDate }}
              />
              <div className="flex justify-end gap-2 border-t border-border px-1 pt-2">
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="brand" disabled={!draft?.from} onClick={apply}>
                  Apply
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
