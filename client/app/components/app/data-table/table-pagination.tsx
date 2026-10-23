import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

import { pageItems } from "./pagination";

const fmt = (n: number) => n.toLocaleString("en-IN");

/**
 * The table footer: "26–50 of 1,240 orders", rows-per-page, numbered pages.
 * `total` is undefined until the first response lands.
 */
export function TablePagination({
  page,
  limit,
  total,
  totalPages,
  noun,
  limitOptions,
  onPage,
  onLimit,
}: {
  page: number;
  limit: number;
  total: number | undefined;
  totalPages: number | undefined;
  noun: string;
  limitOptions: ReadonlyArray<number>;
  onPage: (page: number) => void;
  onLimit: (limit: number) => void;
}) {
  const pages = Math.max(1, totalPages ?? 1);
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = total ? Math.min(page * limit, total) : 0;
  const summary =
    total === undefined ? `Loading ${noun}…` : `${fmt(from)}–${fmt(to)} of ${fmt(total)} ${noun}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 md:px-3 md:py-2">
      <span aria-live="polite" className="w-full text-center text-xs tabular-nums text-muted-foreground md:w-auto md:text-left md:text-label">
        {summary}
      </span>
      <div className="flex w-full flex-wrap items-center justify-between gap-3 md:w-auto md:justify-start md:gap-4">
        <div className="flex items-center gap-2">
          <span className="hidden text-label text-muted-foreground md:inline">Rows per page</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-haspopup="listbox"
                aria-label="Rows per page"
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-card pl-3 pr-2.5 text-label font-medium tabular-nums text-foreground ring-1 ring-border transition-colors hover:bg-muted aria-expanded:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 md:h-7 md:rounded-md md:pl-2.5 md:pr-2"
              >
                {limit}
                <span className="font-normal text-muted-foreground md:hidden">/ page</span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-24 min-w-0">
              <DropdownMenuRadioGroup
                value={String(limit)}
                onValueChange={(value) => onLimit(Number(value))}
              >
                {limitOptions.map((option) => (
                  <DropdownMenuRadioItem key={option} value={String(option)} className="tabular-nums">
                    {option}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <nav aria-label="Pagination" className="flex items-center gap-0.5">
          <PageButton onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft className="size-4" />
          </PageButton>
          <span className="px-2 text-xs tabular-nums text-muted-foreground md:hidden">{fmt(page)} / {fmt(pages)}</span>
          <div className="hidden items-center gap-0.5 md:flex">
          {pageItems(page, pages).map((item, index) =>
            item.kind === "gap" ? (
              <span
                key={`gap-${index}`}
                className="min-w-5 text-center text-label text-muted-foreground/60"
              >
                …
              </span>
            ) : (
              <PageButton
                key={item.page}
                onClick={() => onPage(item.page)}
                aria-label={`Page ${item.page}`}
                aria-current={item.page === page ? "page" : undefined}
                className={cn(
                  "min-w-7 px-1.5 tabular-nums",
                  item.page === page
                    ? "bg-muted font-semibold text-foreground ring-1 ring-border"
                    : "text-muted-foreground",
                )}
              >
                {fmt(item.page)}
              </PageButton>
            ),
          )}
          </div>
          <PageButton onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
            <ChevronRight className="size-4" />
          </PageButton>
        </nav>
      </div>
    </div>
  );
}

function PageButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-11 min-w-11 items-center justify-center rounded-xl bg-muted/60 text-label text-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 md:h-7 md:min-w-7 md:rounded-md md:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}
