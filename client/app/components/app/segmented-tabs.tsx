import { cn } from "~/lib/utils";

interface SegmentedTabsProps<T extends string> {
  /**
   * `icon` is optional and purely decorative — it renders before the label and
   * inherits the pill's colour. Added for the label-stock picker, where the
   * shape of the media (a wide sticker, a thin jewellery flag, a portrait
   * sheet) reads faster than its name.
   */
  items: ReadonlyArray<{
    value: T;
    label: string;
    count?: number;
    icon?: React.ReactNode;
  }>;
  value: T;
  onChange: (value: T) => void;
  /** Required — the control is unlabelled otherwise. */
  ariaLabel: string;
  /**
   * "tabs" — switches the panel below, so `tablist`/`tab` roles and
   * `aria-controls`. The caller must give the matching panel
   * `id={`${idPrefix}-panel-${value}`}` and `role="tabpanel"`.
   *
   * "filter" — narrows content inside a single panel, so `aria-pressed` on plain
   * buttons. There is no tabpanel for a tab to control, so tab roles would lie.
   *
   * The distinction is the one `orders/customers.tsx` already draws; both looks
   * are identical, which is why they share one component rather than being
   * hand-rolled per call site and drifting.
   */
  behaviour?: "tabs" | "filter";
  /** Required when `behaviour="tabs"`, to build the tab/panel id pairs. */
  idPrefix?: string;
  /**
   * "pill" — the ink-on-muted rounded track used in page headers.
   * "table" — the DataTable's tab row: a muted square track where the active
   * tab is a white card with a hairline ring and the count sits muted beside
   * the label. Same roles and behaviour, different skin.
   */
  variant?: "pill" | "table";
  className?: string;
}

/** The pill-track segmented control used for page tabs and filter chips. */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  behaviour = "tabs",
  idPrefix,
  variant = "pill",
  className,
}: SegmentedTabsProps<T>) {
  const isTabs = behaviour === "tabs";
  const isTable = variant === "table";

  return (
    <div
      role={isTabs ? "tablist" : "group"}
      aria-label={ariaLabel}
      className={cn(
        "flex w-fit flex-wrap bg-muted",
        isTable ? "gap-0.5 rounded-lg p-[3px]" : "gap-1 rounded-full p-1",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.value === value;

        return (
          <button
            key={item.value}
            type="button"
            role={isTabs ? "tab" : undefined}
            id={isTabs && idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={
              isTabs && idPrefix ? `${idPrefix}-panel-${item.value}` : undefined
            }
            aria-selected={isTabs ? isActive : undefined}
            aria-pressed={isTabs ? undefined : isActive}
            onClick={() => onChange(item.value)}
            className={cn(
              // Finger-sized on phones and touch screens (the phone contract in app.css).
              "inline-flex items-center transition-colors max-md:min-h-11 pointer-coarse:min-h-11",
              isTable
                ? "h-[30px] gap-2 whitespace-nowrap rounded-lg px-3 text-label font-medium"
                : "gap-1.5 rounded-full px-3 py-1 text-caption font-medium",
              isActive && !isTable && "bg-ink font-semibold text-brand",
              isActive && isTable && "bg-card font-semibold text-foreground shadow-sm ring-1 ring-border",
              !isActive && "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  "tabular-nums",
                  isTable ? "text-caption font-medium text-muted-foreground" : !isActive && "opacity-70",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
