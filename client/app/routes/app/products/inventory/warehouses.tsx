import { useState } from "react";
import {
  Grid3x3,
  Pencil,
  Plus,
  ShoppingBag,
  Star,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useGstins, useIndianStates } from "~/hooks/use-gst-queries";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { ModalShell, DialogFooter } from "~/components/app/order-dialog-primitives";
import {
  useInventoryStatus,
  useWarehouseLocations,
  useWarehouses,
} from "~/hooks/use-inventory-queries";
import { InventoryTabs } from "~/components/app/inventory/inventory-tabs";
import {
  useBulkCreateLocationsMutation,
  useCreateWarehouseMutation,
  useUpdateWarehouseMutation,
} from "~/hooks/use-inventory-mutations";
import type { OrganizationGstin, Warehouse } from "~/types/api";

/** The canonical address shape the server and `lib/address.ts` both read. */
type WarehouseAddress = {
  address1?: string;
  address2?: string;
  city?: string;
  zip?: string;
  province?: string;
  stateCode?: string;
};

const NO_GSTIN = "none";

/**
 * Address + GST registration for a warehouse.
 *
 * A warehouse is a place of business, so this is deliberately NOT the
 * order-create address form: that one collects a person (names, phone,
 * country_code) and would write the wrong keys. `province` and `stateCode` are
 * always written together — the server reads the code, `readAddress` renders
 * the name.
 */
function WarehousePlaceFields({
  address,
  onAddressChange,
  gstinId,
  onGstinChange,
  apobDeclared,
  onApobDeclaredChange,
}: {
  address: WarehouseAddress;
  onAddressChange: (patch: WarehouseAddress) => void;
  gstinId: string | null;
  onGstinChange: (next: string | null) => void;
  apobDeclared: boolean;
  onApobDeclaredChange: (next: boolean) => void;
}) {
  const states = useIndianStates();
  const gstins = useGstins();
  const activeGstins = (gstins.data ?? []).filter((g: OrganizationGstin) => g.isActive);
  const selected = activeGstins.find((g: OrganizationGstin) => g.id === gstinId) ?? null;

  // Advisory only — the server is authoritative and refuses the save. Showing
  // it here means the merchant learns before submitting, not after.
  const stateMismatch =
    selected && address.stateCode && selected.stateCode !== address.stateCode
      ? `This address is in ${address.province || address.stateCode}, but the registration is for ${selected.stateName}. A place of business in another state needs its own GSTIN.`
      : null;

  const field =
    "mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]";
  const label = "text-[10px] font-medium text-gray-600 dark:text-gray-400";

  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        Place of business — printed on invoices as “Dispatch from”
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={label}>Address line 1</label>
          <input
            value={address.address1 ?? ""}
            onChange={(e) => onAddressChange({ address1: e.target.value })}
            placeholder="Building, street"
            className={field}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={label}>Address line 2</label>
          <input
            value={address.address2 ?? ""}
            onChange={(e) => onAddressChange({ address2: e.target.value })}
            placeholder="Area, landmark (optional)"
            className={field}
          />
        </div>
        <div>
          <label className={label}>City</label>
          <input
            value={address.city ?? ""}
            onChange={(e) => onAddressChange({ city: e.target.value })}
            placeholder="City"
            className={field}
          />
        </div>
        <div>
          <label className={label}>PIN code</label>
          <input
            value={address.zip ?? ""}
            onChange={(e) => onAddressChange({ zip: e.target.value })}
            placeholder="6-digit PIN"
            className={field}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={label}>State</label>
          <Select
            value={address.stateCode ?? ""}
            onValueChange={(code) => {
              const state = (states.data ?? []).find((s) => s.code === code);
              onAddressChange({ stateCode: code, province: state?.name ?? "" });
            }}
          >
            <SelectTrigger className="mt-1 h-9 text-xs">
              <SelectValue placeholder="Select state" />
            </SelectTrigger>
            <SelectContent>
              {(states.data ?? []).map((s) => (
                <SelectItem key={s.code} value={s.code} className="text-xs">
                  {s.code} - {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {activeGstins.length > 0 && (
        <div>
          <label className={label}>GST registration</label>
          <Select
            value={gstinId ?? NO_GSTIN}
            onValueChange={(next) => onGstinChange(next === NO_GSTIN ? null : next)}
          >
            <SelectTrigger className="mt-1 h-9 text-xs">
              <SelectValue placeholder="Not linked" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GSTIN} className="text-xs">
                Not linked
              </SelectItem>
              {activeGstins.map((g: OrganizationGstin) => (
                <SelectItem key={g.id} value={g.id} className="text-xs">
                  {g.gstin} — {g.stateName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Makes this an additional place of business of that registration.
          </p>
        </div>
      )}

      {stateMismatch && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700">{stateMismatch}</p>
      )}

      {gstinId && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-[#CEF17B]"
            checked={apobDeclared}
            onChange={(e) => onApobDeclaredChange(e.target.checked)}
          />
          <span className="text-[11px] text-gray-700 dark:text-gray-300">
            Declared as an additional place of business on the GST portal
            <span className="block text-muted-foreground">
              A registration amendment you or your CA file on the portal — this app
              cannot do it for you.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

/** Drop blank values so an untouched form stores nothing at all. */
function cleanAddress(address: WarehouseAddress): WarehouseAddress | undefined {
  const entries = Object.entries(address).filter(
    ([, v]) => typeof v === "string" && v.trim().length > 0,
  );
  // `province` alone is an artefact of picking a state and clearing the rest.
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as WarehouseAddress;
}

/**
 * Warehouse management. Warehouses carrying a Shopify location id are mirrors
 * created by the location sync — their name and active state follow Shopify,
 * so the actions offered on them are deliberately narrower than on a
 * hand-created one.
 */
export default function WarehousesPage() {
  const status = useInventoryStatus();
  const warehouses = useWarehouses();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [griddingFor, setGriddingFor] = useState<Warehouse | null>(null);

  const rows = warehouses.data ?? [];
  const shopifyMapped = rows.filter((w) => w.shopifyLocationId).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Locations</h1>
          <InventoryTabs />
        </div>
        <Button
          variant="brand"
          size="action"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" /> New warehouse
        </Button>
      </div>

      {shopifyMapped > 0 && (
        <p className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-[11px] text-muted-foreground">
          {shopifyMapped} warehouse{shopifyMapped === 1 ? "" : "s"} mirror a Shopify
          location. Their stock is reconciled from Shopify on every sync, and their
          name and active state follow the location — rename them in Shopify.
        </p>
      )}

      {warehouses.isLoading ? (
        <TableSkeleton rows={4} columns={6} />
      ) : warehouses.isError ? (
        <QueryErrorState resource="warehouses" onRetry={() => warehouses.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={WarehouseIcon}
          title="No warehouses yet"
          description={
            status.data?.warehousingEnabled
              ? "Connect Shopify to mirror its locations automatically, or create one by hand."
              : "Enable warehousing from the Inventory page to start tracking stock per warehouse."
          }
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New warehouse
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="px-3 py-2.5 font-medium">Warehouse</th>
                <th className="px-3 py-2.5 font-medium">Code</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">Registration</th>
                <th className="px-3 py-2.5 text-right font-medium">Locations</th>
                <th className="px-3 py-2.5 text-right font-medium">Stock lines</th>
                <th className="px-3 py-2.5 font-medium">State</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <WarehouseRow
                  key={w.id}
                  warehouse={w}
                  onEdit={() => setEditing(w)}
                  onGenerateGrid={() => setGriddingFor(w)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateWarehouseDialog onClose={() => setCreating(false)} />}
      {editing && <EditWarehouseDialog warehouse={editing} onClose={() => setEditing(null)} />}
      {griddingFor && (
        <LocationGridDialog warehouse={griddingFor} onClose={() => setGriddingFor(null)} />
      )}
    </div>
  );
}

function WarehouseRow({
  warehouse: w,
  onEdit,
  onGenerateGrid,
}: {
  warehouse: Warehouse;
  onEdit: () => void;
  onGenerateGrid: () => void;
}) {
  const update = useUpdateWarehouseMutation();
  const gstins = useGstins();
  const linked = (gstins.data ?? []).find((g: OrganizationGstin) => g.id === w.gstinId);
  const gstinLabel = linked ? `${linked.stateName} · ${linked.gstin.slice(-4)}` : "Linked";

  return (
    <tr className="border-b last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/50">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-800">
            <WarehouseIcon className="size-3.5 text-gray-400" />
          </div>
          <span className="font-medium text-gray-900 dark:text-gray-100">{w.name}</span>
          {w.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#CEF17B] px-2 py-0.5 text-[10px] font-semibold text-gray-900">
              <Star className="size-2.5" /> Default
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono">{w.code}</td>
      <td className="px-3 py-2.5">
        {w.shopifyLocationId ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShoppingBag className="size-3" /> Shopify · {w.shopifyLocationId}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">Manual</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {w.gstinId ? (
          <span className="text-[11px] text-muted-foreground">
            {gstinLabel}
            {!w.apobDeclared && (
              <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">
                not declared
              </span>
            )}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">Not linked</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{w.locationCount}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{w.stockLineCount}</td>
      <td className="px-3 py-2.5">
        <span className={w.isActive ? "text-green-600" : "text-muted-foreground"}>
          {w.isActive ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1.5">
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onGenerateGrid}>
            <Grid3x3 className="size-3" /> Locations
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onEdit}>
            <Pencil className="size-3" /> Edit
          </Button>
          {!w.isDefault && w.isActive && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: w.id, data: { isDefault: true } })}
            >
              Make default
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateWarehouseDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState<WarehouseAddress>({});
  const [gstinId, setGstinId] = useState<string | null>(null);
  const [apobDeclared, setApobDeclared] = useState(false);
  const create = useCreateWarehouseMutation();

  // Mirrors CreateWarehouseDto's ^[A-Z0-9]{1,8}$ — the code is the prefix of
  // every location full-code under it, and scanner keyboard-wedges only emit
  // this charset reliably across layouts.
  const codeValid = /^[A-Z0-9]{1,8}$/.test(code);
  const valid = name.trim().length > 0 && codeValid;

  return (
    <ModalShell
      title="New warehouse"
      subtitle="For stock you hold outside Shopify. Shopify locations mirror themselves automatically."
      onClose={onClose}
    >
      <div className="space-y-4 px-6 py-4 text-xs">
        <label className="block space-y-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-xs"
            placeholder="e.g. Overflow Store"
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            Code
            <span className="ml-2 font-normal text-muted-foreground">
              1-8 uppercase letters or digits
            </span>
          </span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="h-8 font-mono text-xs"
            placeholder="WH2"
          />
          {code.length > 0 && !codeValid && (
            <span className="text-[11px] text-red-600">
              Use only A-Z and 0-9, up to 8 characters.
            </span>
          )}
        </label>
        <p className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-[11px] text-muted-foreground">
          Location codes under this warehouse read {code || "WH2"}-A01-S02-B03.
        </p>

        <WarehousePlaceFields
          address={address}
          onAddressChange={(patch) => setAddress((prev) => ({ ...prev, ...patch }))}
          gstinId={gstinId}
          onGstinChange={setGstinId}
          apobDeclared={apobDeclared}
          onApobDeclaredChange={setApobDeclared}
        />
      </div>
      <DialogFooter
        confirmLabel="Create warehouse"
        onConfirm={() =>
          create.mutate(
            {
              name: name.trim(),
              code,
              address: cleanAddress(address),
              gstinId,
              apobDeclared,
            },
            { onSuccess: () => onClose() },
          )
        }
        onClose={onClose}
        pending={create.isPending}
        confirmDisabled={!valid}
      />
    </ModalShell>
  );
}

function EditWarehouseDialog({
  warehouse: w,
  onClose,
}: {
  warehouse: Warehouse;
  onClose: () => void;
}) {
  const [name, setName] = useState(w.name);
  const [address, setAddress] = useState<WarehouseAddress>(
    (w.address ?? {}) as WarehouseAddress,
  );
  const [gstinId, setGstinId] = useState<string | null>(w.gstinId);
  const [apobDeclared, setApobDeclared] = useState(w.apobDeclared);
  const update = useUpdateWarehouseMutation();
  const isShopify = !!w.shopifyLocationId;

  return (
    <ModalShell title="Edit location" subtitle={`${w.name} · ${w.code}`} onClose={onClose}>
      <div className="space-y-4 px-6 py-4 text-xs">
        <label className="block space-y-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-xs"
            autoFocus
          />
          {/* Said at the point of renaming, not only in a banner further down:
              the sync re-adopts Shopify's name on every run, so a rename here
              silently disappears and looks like the save failed. */}
          {isShopify && (
            <span className="block text-[11px] text-amber-700 dark:text-amber-500">
              Renaming here will not stick — the next sync restores the Shopify
              name. Rename the location in Shopify instead.
            </span>
          )}
        </label>

        {isShopify && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            This location mirrors Shopify location {w.shopifyLocationId}. Its active
            state follows that location on every sync, so deactivate it in Shopify
            rather than here. The address below was seeded from Shopify once and is
            yours to edit — syncing never overwrites it.
          </p>
        )}

        <WarehousePlaceFields
          address={address}
          onAddressChange={(patch) => setAddress((prev) => ({ ...prev, ...patch }))}
          gstinId={gstinId}
          onGstinChange={setGstinId}
          apobDeclared={apobDeclared}
          onApobDeclaredChange={setApobDeclared}
        />

        {!w.isDefault && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-[#CEF17B]"
              checked={!w.isActive}
              onChange={(e) =>
                update.mutate({ id: w.id, data: { isActive: !e.target.checked } })
              }
            />
            <span className="text-gray-700 dark:text-gray-300">
              Inactive — hidden from stock operations, history kept
            </span>
          </label>
        )}
        {w.isDefault && (
          <p className="text-[11px] text-muted-foreground">
            The default warehouse cannot be deactivated. Make another one default first.
          </p>
        )}
      </div>
      <DialogFooter
        confirmLabel="Save"
        onConfirm={() =>
          update.mutate(
            {
              id: w.id,
              data: {
                name: name.trim(),
                address: cleanAddress(address),
                // null unlinks; the server distinguishes it from undefined.
                gstinId,
                apobDeclared,
              },
            },
            { onSuccess: () => onClose() },
          )
        }
        onClose={onClose}
        pending={update.isPending}
        confirmDisabled={name.trim().length === 0}
      />
    </ModalShell>
  );
}

function LocationGridDialog({
  warehouse: w,
  onClose,
}: {
  warehouse: Warehouse;
  onClose: () => void;
}) {
  const [racks, setRacks] = useState("5");
  const [shelves, setShelves] = useState("4");
  const [bins, setBins] = useState("6");
  const [letterRacks, setLetterRacks] = useState(true);
  const existing = useWarehouseLocations(w.id);
  const bulk = useBulkCreateLocationsMutation();

  const n = (v: string) => parseInt(v, 10);
  // Bounds mirror BulkLocationsDto (racks 1-50, shelves 1-20, bins 1-50).
  const valid =
    n(racks) >= 1 && n(racks) <= 50 &&
    n(shelves) >= 1 && n(shelves) <= 20 &&
    n(bins) >= 1 && n(bins) <= 50;
  const total = valid ? n(racks) + n(racks) * n(shelves) * (1 + n(bins)) : 0;
  const rackCode = letterRacks ? "A01" : "R01";

  return (
    <ModalShell
      title="Generate locations"
      subtitle={`${w.name} · ${existing.data?.length ?? 0} existing`}
      onClose={onClose}
    >
      <div className="space-y-4 px-6 py-4 text-xs">
        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Racks</span>
            <Input type="number" min={1} max={50} value={racks}
              onChange={(e) => setRacks(e.target.value)} className="h-8 text-xs" />
          </label>
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Shelves / rack</span>
            <Input type="number" min={1} max={20} value={shelves}
              onChange={(e) => setShelves(e.target.value)} className="h-8 text-xs" />
          </label>
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Bins / shelf</span>
            <Input type="number" min={1} max={50} value={bins}
              onChange={(e) => setBins(e.target.value)} className="h-8 text-xs" />
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[#CEF17B]" checked={letterRacks}
            onChange={(e) => setLetterRacks(e.target.checked)} />
          <span className="text-gray-700 dark:text-gray-300">
            Letter the racks (A01, B01…) instead of numbering them (R01, R02…)
          </span>
        </label>

        <p className="rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-[11px] text-muted-foreground">
          {valid ? (
            <>
              Creates <strong>{total}</strong> locations, from{" "}
              <span className="font-mono">{w.code}-{rackCode}-S01-B01</span> onward.
            </>
          ) : (
            "Racks 1-50, shelves 1-20 per rack, bins 1-50 per shelf."
          )}
        </p>

        {(existing.data?.length ?? 0) > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            This warehouse already has locations. Generating a grid whose codes
            overlap the existing ones is rejected outright rather than merged —
            clear them first if you are re-sizing.
          </p>
        )}
      </div>
      <DialogFooter
        confirmLabel={valid ? `Create ${total} locations` : "Create locations"}
        onConfirm={() =>
          bulk.mutate(
            {
              id: w.id,
              data: {
                racks: n(racks),
                shelvesPerRack: n(shelves),
                binsPerShelf: n(bins),
                letterRacks,
              },
            },
            { onSuccess: () => onClose() },
          )
        }
        onClose={onClose}
        pending={bulk.isPending}
        confirmDisabled={!valid}
      />
    </ModalShell>
  );
}
