import { Check } from "lucide-react";

import { cn } from "~/lib/utils";

export const COMPOSER_STEPS = ["Audience", "Template", "Values", "Review & send"] as const;

interface ComposerStepsProps {
  current: number;
  /** The furthest step reached; any step up to it can be revisited. */
  reached: number;
  onSelect: (step: number) => void;
}

/** The numbered rail above the composer body. */
export function ComposerSteps({ current, reached, onSelect }: ComposerStepsProps) {
  return (
    <ol className="grid grid-cols-4 gap-1 rounded-xl bg-muted/60 p-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-3 sm:bg-transparent sm:p-0" aria-label="Broadcast progress">
      {COMPOSER_STEPS.map((label, index) => {
        const isDone = index < current;
        const isCurrent = index === current;
        const canVisit = index <= reached && !isCurrent;

        return (
          <li key={label} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              disabled={!canVisit}
              onClick={() => onSelect(index)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "inline-flex w-full flex-col items-center gap-1.5 rounded-lg px-1 py-2 transition-colors sm:w-auto sm:flex-row sm:gap-2 sm:rounded-full sm:py-1 sm:pl-1 sm:pr-3",
                isCurrent && "bg-card shadow-sm sm:bg-transparent sm:shadow-none",
                canVisit && "hover:bg-muted",
                !canVisit && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold sm:size-6 sm:text-micro",
                  isCurrent && "bg-ink text-brand",
                  isDone && "bg-brand text-brand-foreground",
                  !isCurrent && !isDone && "bg-muted text-muted-foreground",
                )}
              >
                {isDone ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-center text-caption font-medium",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="sm:hidden">{index === 3 ? "Review" : label}</span>
                <span className="hidden sm:inline">{label}</span>
              </span>
            </button>

            {index < COMPOSER_STEPS.length - 1 && (
              <span className="hidden h-px w-6 bg-border sm:block" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}
