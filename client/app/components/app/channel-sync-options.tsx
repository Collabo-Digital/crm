import { Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useSyncSettings } from "~/hooks/use-channel-queries";
import {
  useTriggerSyncMutation,
  useUpdateSyncSettingsMutation,
} from "~/hooks/use-channel-mutations";
import type { Channel, ChannelSyncEntityState } from "~/types/api";

/**
 * Per-entity sync toggles for one channel.
 *
 * "Sync Now" used to be a single hardcoded pull of four entity types, so a
 * merchant who only cared about orders still paid for a full catalogue scan —
 * and the push direction (which creates REAL Shopify orders from unsynced
 * manual ones) was invisible and uncontrollable. Both directions get toggles
 * here; the server enforces them in `runSync`.
 */

const PULL_LABELS: Record<string, string> = {
  locations: "Locations",
  products: "Products",
  orders: "Orders",
  customers: "Customers",
  inventory: "Inventory",
  collections: "Collections",
};

const PUSH_LABELS: Record<string, string> = {
  orders: "Manual orders",
  products: "CRM products",
  drafts: "Drafts",
};

function enabledOf(rows: ChannelSyncEntityState[]): string[] {
  return rows.filter((r) => r.enabled).map((r) => r.entityType);
}

export function ChannelSyncOptions({ channel }: { channel: Channel }) {
  const { data: settings, isPending, isError, refetch } = useSyncSettings(channel.id);
  const save = useUpdateSyncSettingsMutation();
  const triggerSync = useTriggerSyncMutation();

  // The trigger stays mounted in every state so the row's action group never
  // shifts. What differs is whether it can be opened.
  //
  // Loading only. An earlier version disabled on `!settings`, which made a
  // FAILED fetch indistinguishable from a pending one and left a dead control
  // with no explanation — the merchant's only route to these toggles, silently
  // removed by a 500.
  if (isPending) {
    return (
      <button
        disabled
        aria-label="Sync options"
        className="inline-flex items-center justify-center rounded-lg border border-input bg-white dark:bg-gray-900 px-2 py-1.5 text-gray-400 opacity-50"
      >
        <Settings2 className="size-3.5" />
      </button>
    );
  }

  // Failed: still openable, and it says why plus how to retry.
  if (isError || !settings) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Sync options (unavailable)"
            title="Sync settings could not be loaded"
            className="inline-flex items-center justify-center rounded-lg border border-input bg-white dark:bg-gray-900 px-2 py-1.5 text-amber-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <Settings2 className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            Couldn&apos;t load this channel&apos;s sync settings. Syncing still
            works and uses the settings you saved last.
          </p>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void refetch();
            }}
            className="text-xs font-medium"
          >
            Try again
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // MANUAL channels have no pull — `runSync` short-circuits it and ignores
  // entityTypes entirely — so only the push half means anything there.
  const showPull = channel.platform !== "MANUAL";
  const pullEnabled = enabledOf(settings.pull);
  const pushEnabled = enabledOf(settings.push);

  const toggle = (
    direction: "pull" | "push",
    entityType: string,
    on: boolean,
  ) => {
    const next = { pull: pullEnabled, push: pushEnabled };
    next[direction] = on
      ? [...next[direction], entityType]
      : next[direction].filter((e) => e !== entityType);
    save.mutate({ id: channel.id, data: next });
  };

  const pendingFor = (entityType: string): number | null => {
    if (entityType === "orders") return settings.pendingPush.orders;
    if (entityType === "products") return settings.pendingPush.products;
    // Drafts carry no shopifySync marker, so there is no honest count to show.
    return null;
  };

  const nothingToPull = showPull && pullEnabled.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title="Choose what this channel syncs"
          aria-label="Sync options"
          className="inline-flex items-center justify-center rounded-lg border border-input bg-white dark:bg-gray-900 px-2 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <Settings2 className="size-3.5" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        {showPull && (
          <>
            <DropdownMenuLabel className="text-[11px]">
              Pull from Shopify
            </DropdownMenuLabel>
            {settings.pull.map((row) => (
              <DropdownMenuCheckboxItem
                key={`pull-${row.entityType}`}
                checked={row.enabled}
                disabled={save.isPending}
                // Radix closes the menu on select; keep it open so several
                // boxes can be ticked without reopening each time.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(on) => toggle("pull", row.entityType, on)}
                className="text-xs"
              >
                <span className="flex-1">
                  {PULL_LABELS[row.entityType] ?? row.entityType}
                </span>
                {!row.backfillDone && (
                  <span className="text-[10px] text-muted-foreground">
                    not synced yet
                  </span>
                )}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuLabel className="text-[11px]">
          Push to Shopify
        </DropdownMenuLabel>
        <p className="px-2 pb-1 text-[10px] leading-snug text-muted-foreground">
          Off until you switch it on. What you tick is sent on your next Sync,
          and orders created in Shopify cannot be taken back.
        </p>
        {settings.push.map((row) => {
          const pending = pendingFor(row.entityType);
          return (
            <DropdownMenuCheckboxItem
              key={`push-${row.entityType}`}
              checked={row.enabled}
              disabled={save.isPending}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => toggle("push", row.entityType, on)}
              className="text-xs"
            >
              <span className="flex-1">
                {PUSH_LABELS[row.entityType] ?? row.entityType}
              </span>
              {/* The count matters: enabling this sends the whole backlog, and
                  each one becomes a real order in Shopify that cannot be
                  un-created. Better seen here than discovered afterwards. */}
              {pending ? (
                <span className="text-[10px] font-medium text-amber-600">
                  {pending} pending
                </span>
              ) : null}
            </DropdownMenuCheckboxItem>
          );
        })}

        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
          Applies to bulk syncs only — live updates from Shopify keep arriving
          either way. Turning something off never deletes data already synced.
        </p>

        <DropdownMenuItem
          disabled={triggerSync.isPending || nothingToPull}
          onSelect={() =>
            triggerSync.mutate({
              id: channel.id,
              data: { entityTypes: pullEnabled },
            })
          }
          className="text-xs font-medium"
        >
          {nothingToPull
            ? "Nothing selected to pull"
            : triggerSync.isPending
              ? "Starting…"
              : "Sync selected now"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
