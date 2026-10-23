import { Skeleton } from "~/components/ui/skeleton";

/**
 * Placeholder rows for the conversation list.
 *
 * Not TableSkeleton — that one is table-shaped (rows of cells) and would read
 * as a completely different component loading.
 */
export function ConversationListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-start gap-3 px-3 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder bubbles, alternating sides so the shape reads as a thread. */
export function ThreadSkeleton() {
  const widths = ["w-3/5", "w-2/5", "w-1/2", "w-3/5"];

  return (
    <div className="flex flex-col gap-4 p-5" aria-hidden>
      {widths.map((width, index) => (
        <div
          key={index}
          className={index % 2 === 1 ? "flex justify-end" : "flex justify-start"}
        >
          <Skeleton className={`h-12 rounded-xl ${width}`} />
        </div>
      ))}
    </div>
  );
}
