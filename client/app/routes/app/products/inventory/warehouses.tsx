import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  AlertTriangle,
  Grid3x3,
  Loader2,
  Pencil,
  Plus,
  ShoppingBag,
  Star,
  Unlink,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { RadioCard, RadioGroup } from "~/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useGstins, useIndianStates } from "~/hooks/use-gst-queries";
import {
  useChannels,
  usePendingShopifyLocations,
  useShopifyLocations,
} from "~/hooks/use-channel-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { isActiveChannel } from "~/lib/channel-providers";
import {
  ModalShell,
  DialogFooter as ModalFooter,
} from "~/components/app/order-dialog-primitives";
import { ChoiceSegments } from "~/components/app/choice-segments";
import {
  DataTable,
  MonoCell,
  NumCell,
  useDataTableState,
  type ColumnDef,
} from "~/components/app/data-table";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { useWarehouseLocations, useWarehouses } from "~/hooks/use-inventory-queries";
import { InventoryTabs } from "~/components/app/inventory/inventory-tabs";
import {
  LOCATION_KIND_ICON,
  LocationKindBadge,
} from "~/components/app/inventory/location-kind-badge";
import { ShopifyLocationsDialog } from "~/components/app/shopify-locations-dialog";
import {
  useBulkCreateLocationsMutation,
  useCreateWarehouseMutation,
  useUpdateWarehouseMutation,
} from "~/hooks/use-inventory-mutations";
import type {
  LocationAddress,
  LocationGstChoice,
  LocationKind,
  LocationStockSource,
  OrganizationGstin,
  UpdateWarehouseRequest,
  Warehouse,
} from "~/types/api";

/** Mirrors `GSTIN_REGEX` on the server; the server is still the authority. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** `?new=store` arrives from the point of sale when no store exists yet. */
const NEW_KIND_PARAM: Record<string, LocationKind> = {
  store: "STORE",
  warehouse: "WAREHOUSE",
};

const NO_SHOPIFY_LOCATION = "none";

/**
 * Stores and warehouses. Either kind can share stock with one Shopify
 * location; a Shopify location nobody has decided about yet raises the
 * linking banner at the top.
 */
export default function WarehousesPage() {
  const warehouses = useWarehouses();
  const { data: org } = useCurrentOrg();
  const gstOn = !!org?.gstEnabled;
  const [creating, setCreating] = useState<{ kind: LocationKind | null } | null>(null);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [griddingFor, setGriddingFor] = useState<Warehouse | null>(null);
  const [linkingChannelId, setLinkingChannelId] = useState<string | null>(null);
  const pendingStores = usePendingShopifyLocations();

  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const requested = searchParams.get("new");
    if (requested === null) return;
    setCreating({ kind: NEW_KIND_PARAM[requested] ?? null });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const rows = warehouses.data ?? [];

  // Once for the page rather than once per row: the GST column names the
  // linked registration.
  const gstins = useGstins();
  const gstinOf = useCallback(
    (w: Warehouse) => (gstins.data ?? []).find((g: OrganizationGstin) => g.id === w.gstinId),
    [gstins.data],
  );
  const columns = useMemo<ColumnDef<Warehouse>[]>(
    () => [
      {
        key: "warehouse",
        label: "Location",
        width: 280,
        locked: true,
        cell: (w) => {
          const KindIcon = LOCATION_KIND_ICON[w.kind];
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                <KindIcon className="size-3.5 text-muted-foreground" />
              </span>
              <LocationName warehouse={w} />
            </div>
          );
        },
      },
      {
        key: "kind",
        label: "Type",
        width: 110,
        cell: (w) => <LocationKindBadge kind={w.kind} />,
      },
      { key: "code", label: "Code", width: 80, cell: (w) => <MonoCell value={w.code} /> },
      {
        key: "shopify",
        label: "Shopify",
        width: 200,
        minWidth: 170,
        cell: (w) =>
          w.shopifyLocation ? (
            <ShopifyLinkBadge name={w.shopifyLocation.name} />
          ) : (
            <span className="text-caption text-muted-foreground">Not linked</span>
          ),
      },
      ...(gstOn
        ? [
            {
              key: "registration",
              label: "GST",
              width: 250,
              minWidth: 200,
              cell: (w: Warehouse) => <GstSummary warehouse={w} gstin={gstinOf(w)} />,
            },
          ]
        : []),
      {
        key: "locations",
        label: "Bins",
        width: 70,
        align: "right",
        hiddenByDefault: true,
        cell: (w) => <NumCell value={w.locationCount} />,
      },
      {
        key: "stockLines",
        label: "Stock lines",
        width: 90,
        align: "right",
        cell: (w) => <NumCell value={w.stockLineCount} />,
      },
      {
        key: "state",
        label: "Status",
        width: 80,
        cell: (w) => (
          <span className={w.isActive ? "text-success" : "text-muted-foreground"}>
            {w.isActive ? "Active" : "Inactive"}
          </span>
        ),
      },
    ],
    [gstinOf, gstOn],
  );
  // The whole list arrives at once; the table state only carries column
  // visibility here.
  const list = useListUrlState("warehouses");
  const table = useDataTableState({ key: "warehouses", list, columns });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Locations</h1>
          <InventoryTabs />
        </div>
        <Button variant="brand" size="action" onClick={() => setCreating({ kind: null })}>
          <Plus className="size-3.5" /> New location
        </Button>
      </div>

      {pendingStores.map((channel) => (
        <div
          key={channel.id}
          className="flex flex-col gap-3 rounded-xl bg-warning-subtle px-4 py-3 ring-1 ring-warning/25 sm:flex-row sm:items-center"
        >
          <ShoppingBag className="hidden size-5 shrink-0 text-warning sm:block" />
          <div className="min-w-0 flex-1">
            <p className="text-label font-semibold text-foreground">
              Shopify locations need linking
            </p>
            <p className="text-caption text-muted-foreground">
              Choose what each location in {channel.name} does. Their stock doesn&apos;t
              sync until you do.
            </p>
          </div>
          <Button
            variant="brand"
            className="shrink-0"
            onClick={() => setLinkingChannelId(channel.id)}
          >
            Link locations
          </Button>
        </div>
      ))}

      <DataTable
        state={table}
        rows={rows}
        rowKey={(w) => w.id}
        meta={undefined}
        status={{
          isLoading: warehouses.isLoading,
          isError: warehouses.isError,
          refetch: warehouses.refetch,
        }}
        noun="locations"
        searchable={false}
        paginated={false}
        rowActions={(w) => (
          <WarehouseRowActions
            warehouse={w}
            onEdit={() => setEditing(w)}
            onGenerateGrid={() => setGriddingFor(w)}
          />
        )}
        actionsWidth={230}
        mobileRow={(w) => <LocationMobileSummary warehouse={w} gstOn={gstOn} gstin={gstinOf(w)} />}
        emptyState={{
          icon: WarehouseIcon,
          title: "No locations yet",
          description: "Add a store you sell from, or a warehouse that keeps stock.",
          action: (
            <Button size="sm" onClick={() => setCreating({ kind: null })}>
              <Plus className="size-3.5" /> New location
            </Button>
          ),
        }}
      />

      {creating && (
        <LocationDialog initialKind={creating.kind} onClose={() => setCreating(null)} />
      )}
      {editing && <LocationDialog location={editing} onClose={() => setEditing(null)} />}
      {griddingFor && (
        <LocationGridDialog warehouse={griddingFor} onClose={() => setGriddingFor(null)} />
      )}
      <ShopifyLocationsDialog
        channelId={linkingChannelId}
        onOpenChange={(open) => !open && setLinkingChannelId(null)}
      />
    </div>
  );
}

/**
 * The name opens the Stock tab at this location: `useSelectedLocation` reads
 * `?warehouseId` ahead of the saved choice. The Stock tab lists active
 * locations only, so an inactive one stays plain text — its link would
 * silently land on the default instead.
 */
function LocationName({ warehouse: w }: { warehouse: Warehouse }) {
  return (
    <>
      {w.isActive ? (
        <Link
          to={`/products/inventory?warehouseId=${encodeURIComponent(w.id)}`}
          title={`View stock at ${w.name}`}
          // Dotted at rest, like the "Stock" header on the products
          // table, so the name reads as a link before hover.
          className="truncate font-medium text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
        >
          {w.name}
        </Link>
      ) : (
        <span
          title="Inactive — the Stock tab shows active locations only"
          className="truncate font-medium text-foreground"
        >
          {w.name}
        </span>
      )}
      {w.isDefault && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-brand-foreground">
          <Star className="size-2.5" /> Default
        </span>
      )}
    </>
  );
}

function ShopifyLinkBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-start gap-1 rounded-lg bg-[#96bf48]/15 px-2 py-0.5 text-[10px] font-semibold leading-4 text-[#4b6f1f] [overflow-wrap:anywhere] dark:text-[#b5d77a]">
      <ShoppingBag className="mt-0.5 size-2.5 shrink-0" />
      <span>Linked to Shopify: {name}</span>
    </span>
  );
}

function GstSummary({
  warehouse: w,
  gstin,
}: {
  warehouse: Warehouse;
  gstin: OrganizationGstin | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1">
      <span className="truncate text-caption text-muted-foreground">
        {!w.gstinId ? "No GSTIN" : gstin ? `${gstin.gstin} · ${gstin.stateName}` : "GSTIN linked"}
      </span>
      {w.gstWarning && (
        <span className="flex items-start gap-1 text-[11px] leading-snug text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          {w.gstWarning}
        </span>
      )}
    </div>
  );
}

/** One location as a card on phones: what it is, where, and what needs attention. */
function LocationMobileSummary({
  warehouse: w,
  gstOn,
  gstin,
}: {
  warehouse: Warehouse;
  gstOn: boolean;
  gstin: OrganizationGstin | undefined;
}) {
  const city = typeof w.address?.city === "string" ? w.address.city : null;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
        <LocationName warehouse={w} />
        <LocationKindBadge kind={w.kind} />
        {!w.isActive && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            Inactive
          </span>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        {[w.code, city, `${w.stockLineCount} stock lines`, `${w.locationCount} bins`]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {w.shopifyLocation && <ShopifyLinkBadge name={w.shopifyLocation.name} />}
      {gstOn && <GstSummary warehouse={w} gstin={gstin} />}
    </div>
  );
}

/** Bins / Edit / Make default. Owns the mutation so each row shows its own pending state. */
function WarehouseRowActions({
  warehouse: w,
  onEdit,
  onGenerateGrid,
}: {
  warehouse: Warehouse;
  onEdit: () => void;
  onGenerateGrid: () => void;
}) {
  const update = useUpdateWarehouseMutation();

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="outline" size="xs" onClick={onGenerateGrid}>
        <Grid3x3 className="size-3" /> Bins
      </Button>
      <Button variant="outline" size="xs" onClick={onEdit}>
        <Pencil className="size-3" /> Edit
      </Button>
      {!w.isDefault && w.isActive && (
        <Button
          variant="outline"
          size="xs"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: w.id, data: { isDefault: true } })}
        >
          Make default
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────── Create / edit ───────────────────────────

type AddressDraft = Required<LocationAddress>;

function addressDraftOf(address: Record<string, unknown> | null | undefined): AddressDraft {
  const read = (key: string) => {
    const value = address?.[key];
    return typeof value === "string" ? value : "";
  };
  return {
    address1: read("address1"),
    address2: read("address2"),
    city: read("city"),
    zip: read("zip"),
    stateCode: read("stateCode"),
  };
}

const PIN_PATTERN = /^\d{6}$/;

function addressComplete(a: AddressDraft): boolean {
  return (
    a.address1.trim() !== "" &&
    a.city.trim() !== "" &&
    PIN_PATTERN.test(a.zip.trim()) &&
    a.stateCode !== ""
  );
}

function toLocationAddress(a: AddressDraft): LocationAddress {
  return {
    address1: a.address1.trim(),
    ...(a.address2.trim() ? { address2: a.address2.trim() } : {}),
    city: a.city.trim(),
    zip: a.zip.trim(),
    stateCode: a.stateCode,
  };
}

/** The answer to "Does this location have its own GST number?" and the number. */
type GstDraft = {
  answer: "own" | "workspace";
  gstin: string;
  legalName: string;
  tradeName: string;
};

/** The workspace registration that covers a state, the default one first. */
function workspaceGstinFor(
  stateCode: string,
  gstins: OrganizationGstin[],
): OrganizationGstin | undefined {
  const forState = gstins.filter((g) => g.stateCode === stateCode);
  return forState.find((g) => g.isDefault) ?? forState[0];
}

/**
 * What the GST answer means for the server, or null while it is incomplete.
 * A number typed in that the workspace already has is the existing
 * registration, not a second copy of it.
 */
function resolveGst(
  draft: GstDraft,
  stateCode: string,
  gstins: OrganizationGstin[],
): LocationGstChoice | null {
  if (draft.answer === "own") {
    const gstin = draft.gstin.trim().toUpperCase();
    if (!GSTIN_PATTERN.test(gstin)) return null;
    const known = gstins.find((g) => g.gstin === gstin);
    if (known) return { mode: "existing", gstinId: known.id };
    return {
      mode: "new",
      gstin,
      ...(draft.legalName.trim() ? { legalName: draft.legalName.trim() } : {}),
      ...(draft.tradeName.trim() ? { tradeName: draft.tradeName.trim() } : {}),
    };
  }
  if (!stateCode) return null;
  const covering = workspaceGstinFor(stateCode, gstins);
  return covering ? { mode: "existing", gstinId: covering.id } : { mode: "none" };
}

const fieldLabel = "text-caption font-medium text-foreground";

/**
 * Creates a location, or edits one when `location` is given. Everything is
 * saved together, so an edit sends only what changed.
 */
function LocationDialog({
  location,
  initialKind = null,
  onClose,
}: {
  location?: Warehouse;
  initialKind?: LocationKind | null;
  onClose: () => void;
}) {
  const { data: org } = useCurrentOrg();
  const gstOn = !!org?.gstEnabled;
  const states = useIndianStates();
  const gstinsQuery = useGstins();
  const gstins = (gstinsQuery.data ?? []).filter((g: OrganizationGstin) => g.isActive);
  const create = useCreateWarehouseMutation();
  const update = useUpdateWarehouseMutation();

  const [kind, setKind] = useState<LocationKind | null>(location?.kind ?? initialKind);
  const [name, setName] = useState(location?.name ?? "");
  const [code, setCode] = useState(location?.code ?? "");
  const initialAddress = useMemo(() => addressDraftOf(location?.address), [location]);
  const [address, setAddress] = useState<AddressDraft>(initialAddress);
  const [gst, setGst] = useState<GstDraft>({
    answer: "workspace",
    gstin: "",
    legalName: "",
    tradeName: "",
  });
  const [changingGst, setChangingGst] = useState(false);
  const [isActive, setIsActive] = useState(location?.isActive ?? true);

  // Shopify: the first connected store. Its undecided and untracked
  // locations are the ones free to link.
  const channels = useChannels();
  const store = (channels.data ?? []).find(
    (c) => c.platform === "SHOPIFY" && isActiveChannel(c),
  );
  const shopify = useShopifyLocations(store?.id);
  const linkedId = location?.shopifyLocation?.id ?? null;
  const [shopifyLocationId, setShopifyLocationId] = useState<string | null>(linkedId);
  const [stockSource, setStockSource] = useState<LocationStockSource | null>(null);

  // Mirrors CreateWarehouseDto's ^[A-Z0-9]{1,8}$ — the code is the prefix of
  // every bin code under it, and scanner keyboard-wedges only emit this
  // charset reliably across layouts.
  const codeValid = /^[A-Z0-9]{1,8}$/.test(code);
  const stateName = (stateCode: string) =>
    states.data?.find((s) => s.code === stateCode)?.name ?? stateCode;

  const addressChanged = (Object.keys(address) as (keyof AddressDraft)[]).some(
    (key) => address[key].trim() !== initialAddress[key].trim(),
  );
  const addressOk = location && !addressChanged ? true : addressComplete(address);

  // A location already under a registration shows it, and is only asked
  // again when the merchant wants to change it or the state moves.
  const askGst =
    gstOn &&
    (!location?.gstinId || changingGst || address.stateCode !== initialAddress.stateCode);
  const gstChoice = askGst ? resolveGst(gst, address.stateCode, gstins) : null;
  const typedGstin = gst.gstin.trim().toUpperCase();
  const gstinStateCode = /^\d{2}/.test(typedGstin) ? typedGstin.slice(0, 2) : null;
  const gstinMismatch =
    askGst &&
    gst.answer === "own" &&
    !!gstinStateCode &&
    !!address.stateCode &&
    gstinStateCode !== address.stateCode;
  const gstOk = !askGst || (gstChoice !== null && !gstinMismatch);

  const linkOptions = (shopify.data?.locations ?? []).filter(
    (l) => !l.decision || l.decision.action === "ignore" || l.id === linkedId,
  );
  const linking = shopifyLocationId !== null && shopifyLocationId !== linkedId;
  // A new location is empty; an existing one may already hold stock, and then
  // the merchant says whose counts both sides keep.
  const holdsStock =
    !!location &&
    (shopify.data?.warehouses.find((w) => w.id === location.id)?.hasStock ??
      location.stockLineCount > 0);
  const askStockSource = linking && holdsStock;
  const linkOk = !askStockSource || stockSource !== null;

  const valid =
    kind !== null && name.trim() !== "" && codeValid && addressOk && gstOk && linkOk;

  const submit = () => {
    if (!valid || kind === null) return;
    if (!location) {
      create.mutate(
        {
          name: name.trim(),
          code,
          kind,
          address: toLocationAddress(address),
          ...(gstChoice ? { gst: gstChoice } : {}),
          ...(shopifyLocationId
            ? { shopifyLocationId, stockSource: stockSource ?? "shopify" }
            : {}),
        },
        { onSuccess: () => onClose() },
      );
      return;
    }
    const data: UpdateWarehouseRequest = {};
    if (name.trim() !== location.name) data.name = name.trim();
    if (code !== location.code) data.code = code;
    if (kind !== location.kind) data.kind = kind;
    if (addressChanged) data.address = toLocationAddress(address);
    if (gstChoice) data.gst = gstChoice;
    if (shopifyLocationId !== linkedId) {
      // null unlinks; the server tells it apart from leaving the link alone.
      data.shopifyLocationId = shopifyLocationId;
      if (shopifyLocationId) data.stockSource = stockSource ?? "shopify";
    }
    if (isActive !== location.isActive) data.isActive = isActive;
    if (Object.keys(data).length === 0) {
      onClose();
      return;
    }
    update.mutate({ id: location.id, data }, { onSuccess: () => onClose() });
  };

  const pending = create.isPending || update.isPending;
  const linkedLocation = (shopify.data?.locations ?? []).find((l) => l.id === linkedId);
  const linkedName = location?.shopifyLocation?.name ?? linkedLocation?.name ?? "";

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{location ? "Edit location" : "New location"}</DialogTitle>
          <DialogDescription>
            {location
              ? `${location.name} · ${location.code}`
              : "A store sells with the point of sale. A warehouse keeps stock."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <RadioGroup
            value={kind ?? ""}
            onValueChange={(next) => setKind(next as LocationKind)}
            aria-label="Kind of location"
            className="grid-cols-1 sm:grid-cols-2"
          >
            <RadioCard id="location-kind-store" value="STORE" className="p-3">
              <p className="text-label font-semibold text-foreground">Store</p>
              <p className="text-caption text-muted-foreground">
                Sell here with the point of sale.
              </p>
            </RadioCard>
            <RadioCard id="location-kind-warehouse" value="WAREHOUSE" className="p-3">
              <p className="text-label font-semibold text-foreground">Warehouse</p>
              <p className="text-caption text-muted-foreground">
                Keep stock here. No point of sale.
              </p>
            </RadioCard>
          </RadioGroup>
          {location?.kind === "STORE" && kind === "WAREHOUSE" && (
            <p className="-mt-2 text-caption text-muted-foreground">
              The point of sale stops offering this location once it is a warehouse.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="space-y-1">
              <label htmlFor="location-name" className={fieldLabel}>
                Name
              </label>
              <Input
                id="location-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9"
                placeholder={kind === "STORE" ? "e.g. Kochi store" : "e.g. Main warehouse"}
                autoFocus={!location}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="location-code" className={fieldLabel}>
                Code
              </label>
              <Input
                id="location-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="h-9 font-mono"
                placeholder="WH2"
                maxLength={8}
                aria-describedby="location-code-help"
              />
            </div>
            <p
              id="location-code-help"
              className={
                code.length > 0 && !codeValid
                  ? "text-caption text-danger sm:col-span-2"
                  : "text-caption text-muted-foreground sm:col-span-2"
              }
            >
              {code.length > 0 && !codeValid
                ? "Use only A-Z and 0-9, up to 8 characters."
                : `Up to 8 letters or digits. Bins here read ${code || "WH2"}-A01-S02-B03.`}
            </p>
          </div>

          <LocationAddressFields
            address={address}
            onChange={(patch) => setAddress((prev) => ({ ...prev, ...patch }))}
            required={!location || addressChanged}
          />

          {gstOn && (
            <section className="space-y-3 border-t border-border pt-4">
              <h3 className="text-label font-semibold text-foreground">GST</h3>
              {askGst ? (
                <LocationGstFields
                  draft={gst}
                  onChange={(patch) => setGst((prev) => ({ ...prev, ...patch }))}
                  stateCode={address.stateCode}
                  stateName={stateName}
                  gstins={gstins}
                  gstinStateCode={gstinStateCode}
                  mismatch={gstinMismatch}
                />
              ) : (
                <CurrentGst
                  gstin={gstins.find((g) => g.id === location?.gstinId)}
                  onChange={() => setChangingGst(true)}
                />
              )}
            </section>
          )}

          {store && shopify.data && (linkOptions.length > 0 || linkedId) && (
            <section className="space-y-3 border-t border-border pt-4">
              <h3 className="text-label font-semibold text-foreground">Shopify</h3>
              {linkedId && shopifyLocationId === linkedId ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
                  <ShopifyLinkBadge name={linkedName} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setShopifyLocationId(null)}
                  >
                    <Unlink /> Unlink
                  </Button>
                  <p className="basis-full text-caption text-muted-foreground">
                    Collabo and Shopify keep this location&apos;s stock in step.
                  </p>
                </div>
              ) : linkedId && shopifyLocationId === null ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-subtle p-3">
                  <p className="min-w-0 flex-1 text-caption text-foreground">
                    {linkedName} will be unlinked when you save. Stock here stops syncing
                    with Shopify.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShopifyLocationId(linkedId)}
                  >
                    Undo
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <label htmlFor="location-shopify" className={fieldLabel}>
                    Link to a Shopify location
                  </label>
                  <Select
                    value={shopifyLocationId ?? NO_SHOPIFY_LOCATION}
                    onValueChange={(next) => {
                      setShopifyLocationId(next === NO_SHOPIFY_LOCATION ? null : next);
                      setStockSource(null);
                    }}
                  >
                    <SelectTrigger id="location-shopify" className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SHOPIFY_LOCATION}>Don&apos;t link</SelectItem>
                      {linkOptions.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                          {l.isPrimary ? " (Main)" : ""}
                          {l.address?.city ? ` · ${l.address.city}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-caption text-muted-foreground">
                    A linked location shares the same stock with Shopify.
                  </p>
                </div>
              )}

              {askStockSource && (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-caption text-foreground">
                    {location?.name} already has stock. Whose counts should both keep?
                  </legend>
                  <RadioGroup
                    value={stockSource ?? ""}
                    onValueChange={(next) => setStockSource(next as LocationStockSource)}
                  >
                    <RadioCard id="location-source-shopify" value="shopify" className="p-3">
                      <p className="text-label font-medium text-foreground">
                        Keep Shopify&apos;s counts
                      </p>
                      <p className="text-caption text-muted-foreground">
                        Collabo&apos;s counts here are replaced with Shopify&apos;s.
                      </p>
                    </RadioCard>
                    <RadioCard id="location-source-collabo" value="collabo" className="p-3">
                      <p className="text-label font-medium text-foreground">
                        Keep Collabo&apos;s counts and update Shopify
                      </p>
                      <p className="text-caption text-muted-foreground">
                        Shopify&apos;s counts are replaced with the ones here.
                      </p>
                    </RadioCard>
                  </RadioGroup>
                </fieldset>
              )}
            </section>
          )}

          {location &&
            (location.isDefault ? (
              <p className="border-t border-border pt-4 text-caption text-muted-foreground">
                The default location cannot be made inactive. Make another one default first.
              </p>
            ) : (
              <label className="flex min-h-11 items-center gap-2 border-t border-border pt-4 md:min-h-0">
                <input
                  type="checkbox"
                  className="size-4 accent-[#CEF17B]"
                  checked={!isActive}
                  onChange={(e) => setIsActive(!e.target.checked)}
                />
                <span className="text-caption text-foreground">
                  Inactive — hidden from stock operations, history kept
                </span>
              </label>
            ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="accent" onClick={submit} disabled={!valid || pending}>
            {pending && <Loader2 className="animate-spin" />}
            {location ? "Save changes" : "Create location"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The location's address. A location is a place of business, so this is
 * deliberately NOT the order-create address form: that one collects a person
 * (names, phone, country_code) and would write the wrong keys.
 */
function LocationAddressFields({
  address,
  onChange,
  required,
}: {
  address: AddressDraft;
  onChange: (patch: Partial<AddressDraft>) => void;
  /** Off while editing a location whose address is left as it was. */
  required: boolean;
}) {
  const states = useIndianStates();
  const zipInvalid = address.zip.trim() !== "" && !PIN_PATTERN.test(address.zip.trim());

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="text-label font-semibold text-foreground">Address</h3>
        <p className="text-caption text-muted-foreground">
          Printed on invoices for sales and dispatches from here.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="location-address1" className={fieldLabel}>
            Address line 1
          </label>
          <Input
            id="location-address1"
            value={address.address1}
            onChange={(e) => onChange({ address1: e.target.value })}
            placeholder="Building, street"
            className="h-9"
            autoComplete="address-line1"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="location-address2" className={fieldLabel}>
            Address line 2 <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="location-address2"
            value={address.address2}
            onChange={(e) => onChange({ address2: e.target.value })}
            placeholder="Area, landmark"
            className="h-9"
            autoComplete="address-line2"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="location-city" className={fieldLabel}>
            City
          </label>
          <Input
            id="location-city"
            value={address.city}
            onChange={(e) => onChange({ city: e.target.value })}
            className="h-9"
            autoComplete="address-level2"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="location-zip" className={fieldLabel}>
            PIN code
          </label>
          <Input
            id="location-zip"
            value={address.zip}
            onChange={(e) => onChange({ zip: e.target.value })}
            inputMode="numeric"
            maxLength={6}
            placeholder="6 digits"
            className="h-9"
            aria-invalid={zipInvalid || undefined}
            autoComplete="postal-code"
          />
          {zipInvalid && (
            <p className="text-caption text-danger">Enter the 6-digit PIN code.</p>
          )}
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="location-state" className={fieldLabel}>
            State
          </label>
          <Select
            value={address.stateCode}
            onValueChange={(stateCode) => onChange({ stateCode })}
          >
            <SelectTrigger id="location-state" className="h-9 w-full">
              <SelectValue placeholder="Choose the state" />
            </SelectTrigger>
            <SelectContent>
              {(states.data ?? []).map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {required && !addressComplete(address) && (
        <p className="text-caption text-muted-foreground">
          Line 1, city, PIN code and state are needed.
        </p>
      )}
    </section>
  );
}

/** An edited location's registration as it stands, with a way to change it. */
function CurrentGst({
  gstin,
  onChange,
}: {
  gstin: OrganizationGstin | undefined;
  onChange: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-caption text-foreground">
        {gstin ? (
          <>
            Sales from here are billed under{" "}
            <span className="font-mono">{gstin.gstin}</span> ({gstin.stateName}).
          </>
        ) : (
          "Sales from here are billed under a GSTIN that is no longer active."
        )}
      </p>
      <Button variant="outline" size="sm" onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

/**
 * "Does this location have its own GST number?" Yes takes the number and
 * checks its state against the address; no uses the workspace's registration
 * for the address's state, or says plainly that there is none.
 */
function LocationGstFields({
  draft,
  onChange,
  stateCode,
  stateName,
  gstins,
  gstinStateCode,
  mismatch,
}: {
  draft: GstDraft;
  onChange: (patch: Partial<GstDraft>) => void;
  stateCode: string;
  stateName: (code: string) => string;
  gstins: OrganizationGstin[];
  gstinStateCode: string | null;
  mismatch: boolean;
}) {
  const typed = draft.gstin.trim().toUpperCase();
  const known = gstins.find((g) => g.gstin === typed);
  const covering = stateCode ? workspaceGstinFor(stateCode, gstins) : undefined;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className={fieldLabel}>
          Does this location have its own GST number?
        </p>
        <ChoiceSegments
          label="Does this location have its own GST number?"
          value={draft.answer}
          options={[
            { value: "own", label: "Yes" },
            { value: "workspace", label: "No" },
          ]}
          onChange={(answer) => onChange({ answer })}
          className="w-full sm:w-48"
        />
      </div>

      {draft.answer === "own" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="location-gstin" className={fieldLabel}>
              GSTIN
            </label>
            <Input
              id="location-gstin"
              value={draft.gstin}
              onChange={(e) => onChange({ gstin: e.target.value.toUpperCase() })}
              placeholder="29ABCDE1234F1Z5"
              maxLength={15}
              className="h-9 font-mono"
              autoCapitalize="characters"
              aria-invalid={mismatch || undefined}
            />
            {gstinStateCode && (
              <p className="text-caption text-muted-foreground">
                GSTIN state: {stateName(gstinStateCode)} ({gstinStateCode})
              </p>
            )}
            {typed.length === 15 && !GSTIN_PATTERN.test(typed) && (
              <p className="text-caption text-danger">
                This is not a valid GSTIN. Check it against the registration certificate.
              </p>
            )}
          </div>
          {mismatch && (
            <p className="flex items-start gap-1.5 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              This GSTIN is for {stateName(gstinStateCode!)} but the location is in{" "}
              {stateName(stateCode)}. Check the number or the state before saving.
            </p>
          )}
          {known ? (
            <p className="text-caption text-muted-foreground">
              This GSTIN is already in your workspace, so this location will use it.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="location-legal-name" className={fieldLabel}>
                  Legal name <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="location-legal-name"
                  value={draft.legalName}
                  onChange={(e) => onChange({ legalName: e.target.value })}
                  placeholder="As on the certificate"
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="location-trade-name" className={fieldLabel}>
                  Trade name <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="location-trade-name"
                  value={draft.tradeName}
                  onChange={(e) => onChange({ tradeName: e.target.value })}
                  className="h-9"
                />
              </div>
            </div>
          )}
        </div>
      ) : !stateCode ? (
        <p className="text-caption text-muted-foreground">
          Choose the state above to see which GSTIN applies.
        </p>
      ) : covering ? (
        <div className="space-y-1 rounded-lg bg-muted px-3 py-2.5">
          <p className="text-caption text-foreground">
            Sales from here will use your {covering.stateName} GSTIN,{" "}
            <span className="font-mono">{covering.gstin}</span>.
          </p>
          <p className="text-caption text-muted-foreground">
            Add this address to that registration as an additional place of business on
            the GST portal.
          </p>
        </div>
      ) : (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            Your workspace has no GSTIN for {stateName(stateCode)} yet, so GST invoices
            can&apos;t be issued for sales from here until one is added in Settings, under
            Tax &amp; GST.
          </span>
        </p>
      )}
    </div>
  );
}

// ─────────────────────────── Bins ───────────────────────────

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
      title="Generate bins"
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
              Creates <strong>{total}</strong> racks, shelves and bins, from{" "}
              <span className="font-mono">{w.code}-{rackCode}-S01-B01</span> onward.
            </>
          ) : (
            "Racks 1-50, shelves 1-20 per rack, bins 1-50 per shelf."
          )}
        </p>

        {(existing.data?.length ?? 0) > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            This location already has bins. Generating a grid whose codes overlap the
            existing ones is rejected outright rather than merged — clear them first if
            you are re-sizing.
          </p>
        )}
      </div>
      <ModalFooter
        confirmLabel={valid ? `Create ${total} racks, shelves and bins` : "Create bins"}
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
