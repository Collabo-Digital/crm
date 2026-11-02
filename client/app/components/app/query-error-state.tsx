import { isAxiosError } from "axios";
import { AlertTriangle, SearchX } from "lucide-react";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/app/empty-state";

interface QueryErrorStateProps {
  /** What failed to load, lowercase, e.g. "orders" or "this order". */
  resource: string;
  /** Bind to the query's `refetch` — not a page reload. */
  onRetry: () => void;
  description?: string;
  /**
   * The query's error. A 404 means the record was deleted or the link is
   * wrong, which neither the connection nor Try again can fix.
   */
  error?: unknown;
}

/**
 * Shown when a query FAILED, as opposed to succeeding with nothing in it.
 *
 * Those two were previously indistinguishable: a 500 or a dropped connection
 * left `data` undefined, the page coalesced that to `[]`, and the user was told
 * "No orders found — orders will appear here once synced from your channels".
 * A broken page and a brand-new store looked identical.
 *
 * Deliberately a thin wrapper over `EmptyState` rather than a new design: that
 * component already takes an `icon` and an `action`, and several routes already
 * pass a Button as the action. This exists only so the wording and the retry
 * affordance stay identical across call sites.
 */
export function QueryErrorState({ resource, onRetry, description, error }: QueryErrorStateProps) {
  if (isAxiosError(error) && error.response?.status === 404) {
    return (
      <EmptyState
        icon={SearchX}
        title={`Couldn't find ${resource}`}
        description="It may have been deleted, or the link may be wrong."
      />
    );
  }
  return (
    <EmptyState
      icon={AlertTriangle}
      title={`Couldn't load ${resource}`}
      description={
        description ??
        "Something went wrong on our end — this isn't an empty result. Check your connection and try again."
      }
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
