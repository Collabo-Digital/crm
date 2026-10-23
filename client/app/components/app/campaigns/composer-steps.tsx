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
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {COMPOSER_STEPS.map((label, index) => {
        const isDone = index < current;
        const isCurrent = index === current;
        const canVisit = index <= reached && !isCurrent;

        return (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canVisit}
              onClick={() => onSelect(index)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors",
                canVisit && "hover:bg-muted",
                !canVisit && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-micro font-semibold",
                  isCurrent && "bg-ink text-brand",
                  isDone && "bg-brand text-brand-foreground",
                  !isCurrent && !isDone && "bg-muted text-muted-foreground",
                )}
              >
                {isDone ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-caption font-medium",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </button>

            {index < COMPOSER_STEPS.length - 1 && (
              <span className="h-px w-6 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}
