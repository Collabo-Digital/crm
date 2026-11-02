const FAST_MS = 3_000;
/** How long to poll quickly; most syncs settle well inside this. */
const FAST_FOR_MS = 30_000;
const SLOW_MS = 10_000;
/** A job that has not settled by now is lost. Stop asking rather than poll forever. */
const GIVE_UP_AFTER_MS = 15 * 60_000;
/** Past that, for pollers told to wait longer (Meta can take a day to review a template). */
const LATE_MS = 60_000;

/**
 * Builds a `refetchInterval` that polls only while `isBusy(data)` is true:
 * quickly at first, then slowly, then not at all. It stops by itself the
 * moment the data says the work has settled.
 *
 * Background work (a Shopify push, a channel sync) finishes on the server with
 * nothing to tell the page, and `staleTime` + `refetchOnWindowFocus: false`
 * mean a query is otherwise read once. Without polling, a "Syncing" badge
 * stays on screen until the page is reloaded.
 *
 * `giveUpAfterMs` keeps polling past 15 minutes, once a minute, for work that
 * is slow but not lost.
 *
 * Create it ONCE at module level, never inside a hook body: the "busy since"
 * clock lives in this closure, and a new one per render would never expire.
 */
export function pollWhile<TData>(isBusy: (data: TData | undefined) => boolean, { giveUpAfterMs = GIVE_UP_AFTER_MS } = {}) {
  const busySince = new WeakMap<object, number>();

  return (query: { state: { data: TData | undefined } }): number | false => {
    if (!isBusy(query.state.data)) {
      busySince.delete(query);
      return false;
    }
    const since = busySince.get(query) ?? Date.now();
    busySince.set(query, since);

    const elapsed = Date.now() - since;
    if (elapsed > giveUpAfterMs) return false;
    return elapsed < FAST_FOR_MS ? FAST_MS : elapsed < GIVE_UP_AFTER_MS ? SLOW_MS : LATE_MS;
  };
}
