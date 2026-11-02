import { useMemo, useState } from "react";
import { Check, Loader2, MapPin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { RadioCard, RadioGroup } from "~/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ChoiceSegments } from "~/components/app/choice-segments";
import { LOCATION_KIND_LABEL } from "~/components/app/inventory/location-kind-badge";
import { useShopifyLocations } from "~/hooks/use-channel-queries";
import { useSaveShopifyLocationsMutation } from "~/hooks/use-channel-mutations";
import { useIndianStates } from "~/hooks/use-gst-queries";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import type {
  LocationKind,
  LocationStockSource,
  ShopifyLocation,
  ShopifyLocationDecisionInput,
  ShopifyLocationsResponse,
} from "~/types/api";

type Choice =
  | { action: "link"; warehouseId: string | null; stockSource: LocationStockSource | null }
  | { action: "create"; kind: LocationKind }
  | { action: "ignore" };

type Candidate = ShopifyLocationsResponse["warehouses"][number];

/**
 * Decides what each of a Shopify store's locations does in Collabo: share
 * stock with one of the workspace's own locations, become a new location, or
 * stay untracked. Opened after connecting a store, from its card in Channels,
 * and from the Locations page while any location is undecided.
 */
export function ShopifyLocationsDialog({
  channelId,
  onOpenChange,
}: {
  /** The Shopify channel to decide for; null keeps the dialog closed. */
  channelId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!channelId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link Shopify locations</DialogTitle>
          <DialogDescription>
            Collabo and Shopify will keep these locations&apos; stock in step.
          </DialogDescription>
        </DialogHeader>
        {channelId && (
          <ShopifyLocationsBody
            key={channelId}
            channelId={channelId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The suggested choice for every location still open. The Main location
 * shares stock with the default location only while that one is empty — with
 * stock on both sides the merchant has to say whose counts win, so it is
 * never preselected.
 */
function defaultChoices(
  data: ShopifyLocationsResponse,
  defaultWarehouseId: string | undefined,
): Record<string, Choice> {
  const main = data.warehouses.find((w) => w.id === defaultWarehouseId) ?? data.warehouses[0];
  const choices: Record<string, Choice> = {};
  for (const location of data.locations) {
    if (location.decision?.action === "ignore") choices[location.id] = { action: "ignore" };
    if (location.decision) continue;
    const mainIsFree =
      !!main && !main.hasStock && (!main.shopifyLocationId || main.shopifyLocationId === location.id);
    if (!location.isActive) choices[location.id] = { action: "ignore" };
    else if (location.isPrimary && mainIsFree)
      choices[location.id] = { action: "link", warehouseId: main.id, stockSource: "shopify" };
    else choices[location.id] = { action: "create", kind: "WAREHOUSE" };
  }
  return choices;
}

function isComplete(choice: Choice, candidates: Candidate[]): boolean {
  if (choice.action !== "link") return true;
  const target = candidates.find((w) => w.id === choice.warehouseId);
  if (!target) return false;
  return !target.hasStock || choice.stockSource !== null;
}

function toDecision(location: ShopifyLocation, choice: Choice): ShopifyLocationDecisionInput {
  if (choice.action === "link") {
    return {
      shopifyLocationId: location.id,
      action: "link",
      warehouseId: choice.warehouseId!,
      stockSource: choice.stockSource ?? "shopify",
    };
  }
  if (choice.action === "create") {
    return { shopifyLocationId: location.id, action: "create", kind: choice.kind };
  }
  return { shopifyLocationId: location.id, action: "ignore" };
}

function ShopifyLocationsBody({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const query = useShopifyLocations(channelId);
  const ownLocations = useWarehouses();
  const states = useIndianStates();
  const save = useSaveShopifyLocationsMutation();
  const [edits, setEdits] = useState<Record<string, Choice>>({});
  // Untracked locations are decided, but may be taken back up.
  const [reopened, setReopened] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState<Record<string, Choice> | null>(null);

  const data = query.data;
  const defaultWarehouseId = ownLocations.data?.find((w) => w.isDefault)?.id;
  const defaults = useMemo(
    () => (data ? defaultChoices(data, defaultWarehouseId) : {}),
    [data, defaultWarehouseId],
  );

  const placeOf = (location: ShopifyLocation) => {
    if (!location.address) return null;
    const state =
      states.data?.find((s) => s.code === location.address!.stateCode)?.name ??
      location.address.stateCode;
    return [location.address.city, state].filter(Boolean).join(", ");
  };

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading the Shopify locations…
      </p>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3 py-4">
        <p className="text-caption text-danger">The Shopify locations could not be loaded.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (submitted) {
    return <SavedSummary data={data} submitted={submitted} onDone={onDone} />;
  }

  if (data.locations.length === 0) {
    return (
      <>
        <p className="flex items-center gap-2 py-6 text-caption text-muted-foreground">
          {data.status === "PENDING" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Reading the locations from Shopify…
            </>
          ) : (
            "This Shopify store has no locations."
          )}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  const isOpen = (location: ShopifyLocation) =>
    location.decision === null || reopened.has(location.id);
  const open = data.locations.filter(isOpen);
  const choiceFor = (location: ShopifyLocation): Choice =>
    edits[location.id] ?? defaults[location.id] ?? { action: "ignore" };
  const setChoice = (id: string, choice: Choice) =>
    setEdits((prev) => ({ ...prev, [id]: choice }));

  // One Collabo location shares stock with one Shopify location at most.
  const candidatesFor = (location: ShopifyLocation) => {
    const taken = new Set(
      open
        .filter((l) => l.id !== location.id)
        .map(choiceFor)
        .flatMap((c) => (c.action === "link" && c.warehouseId ? [c.warehouseId] : [])),
    );
    return data.warehouses.filter(
      (w) => (!w.shopifyLocationId || w.shopifyLocationId === location.id) && !taken.has(w.id),
    );
  };

  const ready = open.every((l) => isComplete(choiceFor(l), candidatesFor(l)));
  // Undecided first; a location taken back up with Change stays where it was.
  const ordered = [...data.locations].sort(
    (a, b) => Number(a.decision !== null) - Number(b.decision !== null),
  );

  const submit = () => {
    const choices = Object.fromEntries(open.map((l) => [l.id, choiceFor(l)]));
    save.mutate(
      {
        id: channelId,
        data: { decisions: open.map((l) => toDecision(l, choices[l.id])) },
      },
      { onSuccess: () => setSubmitted(choices) },
    );
  };

  return (
    <>
      {open.length > 0 && (
        <p className="text-caption text-muted-foreground">
          Choose what each location does. Nothing syncs for a location until you save.
        </p>
      )}
      <ul className="space-y-3">
        {ordered.map((location) =>
          isOpen(location) ? (
            <OpenLocationRow
              key={location.id}
              location={location}
              place={placeOf(location)}
              choice={choiceFor(location)}
              candidates={candidatesFor(location)}
              onChange={(choice) => setChoice(location.id, choice)}
            />
          ) : (
            <DecidedLocationRow
              key={location.id}
              location={location}
              place={placeOf(location)}
              onChange={() => setReopened((prev) => new Set(prev).add(location.id))}
            />
          ),
        )}
      </ul>
      <DialogFooter>
        {open.length > 0 ? (
          <>
            <Button variant="outline" onClick={onDone} disabled={save.isPending}>
              Not now
            </Button>
            <Button variant="accent" onClick={submit} disabled={!ready || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Save {open.length === 1 ? "1 location" : `${open.length} locations`}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function LocationHeading({ location, place }: { location: ShopifyLocation; place: string | null }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <MapPin className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-label font-medium text-foreground [overflow-wrap:anywhere]">
          {location.name}
          {location.isPrimary && (
            <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold leading-4 text-brand-foreground">
              Main
            </span>
          )}
          {!location.isActive && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold leading-4 text-muted-foreground">
              Inactive in Shopify
            </span>
          )}
        </p>
        <p className="text-caption text-muted-foreground">{place ?? "No address in Shopify"}</p>
      </div>
    </div>
  );
}

function OpenLocationRow({
  location,
  place,
  choice,
  candidates,
  onChange,
}: {
  location: ShopifyLocation;
  place: string | null;
  choice: Choice;
  candidates: Candidate[];
  onChange: (choice: Choice) => void;
}) {
  const target =
    choice.action === "link" ? candidates.find((w) => w.id === choice.warehouseId) : undefined;

  return (
    <li className="space-y-3 rounded-xl border border-border p-3 sm:p-4">
      <LocationHeading location={location} place={place} />

      <ChoiceSegments
        label={`What ${location.name} does`}
        value={choice.action}
        options={[
          { value: "link", label: "Share stock", disabled: candidates.length === 0 },
          { value: "create", label: "New location" },
          { value: "ignore", label: "Don't track" },
        ]}
        onChange={(action) =>
          onChange(
            action === "link"
              ? { action, warehouseId: null, stockSource: null }
              : action === "create"
                ? { action, kind: "WAREHOUSE" }
                : { action },
          )
        }
      />

      {choice.action === "link" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <label
              htmlFor={`share-${location.id}`}
              className="text-caption font-medium text-foreground"
            >
              Share stock with
            </label>
            <Select
              value={choice.warehouseId ?? ""}
              onValueChange={(id) => {
                const picked = candidates.find((w) => w.id === id);
                onChange({
                  action: "link",
                  warehouseId: id,
                  stockSource: picked?.hasStock ? null : "shopify",
                });
              }}
            >
              <SelectTrigger id={`share-${location.id}`} className="w-full">
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} · {LOCATION_KIND_LABEL[w.kind]}
                    {w.hasStock ? " · has stock" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {target?.hasStock && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-caption text-foreground">
                {target.name} already has stock. Whose counts should both keep?
              </legend>
              <RadioGroup
                value={choice.stockSource ?? ""}
                onValueChange={(source) =>
                  onChange({ ...choice, stockSource: source as LocationStockSource })
                }
              >
                <RadioCard id={`${location.id}-source-shopify`} value="shopify" className="p-3">
                  <p className="text-label font-medium text-foreground">Keep Shopify&apos;s counts</p>
                  <p className="text-caption text-muted-foreground">
                    Collabo&apos;s counts at {target.name} are replaced with Shopify&apos;s.
                  </p>
                </RadioCard>
                <RadioCard id={`${location.id}-source-collabo`} value="collabo" className="p-3">
                  <p className="text-label font-medium text-foreground">
                    Keep Collabo&apos;s counts and update Shopify
                  </p>
                  <p className="text-caption text-muted-foreground">
                    Shopify&apos;s counts at {location.name} are replaced with Collabo&apos;s.
                  </p>
                </RadioCard>
              </RadioGroup>
            </fieldset>
          )}
          {target && !target.hasStock && (
            <p className="text-caption text-muted-foreground">
              {target.name} has no stock yet, so it starts with Shopify&apos;s counts.
            </p>
          )}
        </div>
      )}

      {choice.action === "create" && (
        <div className="space-y-2">
          <p className="text-caption text-muted-foreground">
            Collabo adds a new online location called “{location.name}” and keeps its
            stock in step with Shopify.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ChoiceSegments
              label={`Kind of location for ${location.name}`}
              value={choice.kind}
              options={[
                { value: "WAREHOUSE", label: "Warehouse" },
                { value: "STORE", label: "Store" },
              ]}
              onChange={(kind) => onChange({ action: "create", kind })}
              className="w-full sm:w-56"
            />
            <p className="text-caption text-muted-foreground">
              {choice.kind === "STORE"
                ? "It can sell with the point of sale."
                : "It holds stock, with no point of sale."}
            </p>
          </div>
        </div>
      )}

      {choice.action === "ignore" && (
        <p className="text-caption text-muted-foreground">
          Collabo won&apos;t track stock at this location. You can change this later.
        </p>
      )}
    </li>
  );
}

function DecidedLocationRow({
  location,
  place,
  onChange,
}: {
  location: ShopifyLocation;
  place: string | null;
  onChange: () => void;
}) {
  const decision = location.decision!;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-muted/40 p-3 sm:p-4">
      <div className="min-w-0 flex-1 basis-56">
        <LocationHeading location={location} place={place} />
      </div>
      {decision.action === "ignore" ? (
        <div className="flex items-center gap-2">
          <span className="text-caption text-muted-foreground">Not tracked</span>
          <Button variant="outline" size="sm" onClick={onChange}>
            Change
          </Button>
        </div>
      ) : (
        <span className="flex items-center gap-1.5 text-caption text-foreground">
          <Check className="size-3.5 shrink-0 text-success" />
          Shares stock with {decision.warehouseName}
        </span>
      )}
    </li>
  );
}

/** What the save did, location by location, from the server's answer. */
function SavedSummary({
  data,
  submitted,
  onDone,
}: {
  data: ShopifyLocationsResponse;
  submitted: Record<string, Choice>;
  onDone: () => void;
}) {
  const saved = data.locations.filter((l) => submitted[l.id]);
  const describe = (location: ShopifyLocation): string => {
    const choice = submitted[location.id];
    const decision = location.decision;
    if (decision?.action === "link") {
      return choice.action === "link" && choice.stockSource === "collabo"
        ? `Shares stock with ${decision.warehouseName}. Shopify is being updated with Collabo's counts.`
        : `Shares stock with ${decision.warehouseName}, starting from Shopify's counts.`;
    }
    if (decision?.action === "create") {
      const kind = choice.action === "create" ? LOCATION_KIND_LABEL[choice.kind].toLowerCase() : "location";
      return `New ${kind} “${decision.warehouseName}” added. It shares stock with Shopify.`;
    }
    if (decision?.action === "ignore") return "Not tracked.";
    return "Still waiting for a choice.";
  };

  return (
    <>
      <p className="flex items-center gap-2 text-label font-medium text-foreground">
        <Check className="size-4 text-success" />
        {saved.length === 1 ? "1 location saved." : `${saved.length} locations saved.`}
      </p>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {saved.map((location) => (
          <li key={location.id} className="px-3 py-2.5 sm:px-4">
            <p className="text-label font-medium text-foreground [overflow-wrap:anywhere]">
              {location.name}
            </p>
            <p className="text-caption text-muted-foreground">{describe(location)}</p>
          </li>
        ))}
      </ul>
      {data.status === "PENDING" && (
        <p className="text-caption text-warning">
          Some locations still need a choice. Open this again to finish them.
        </p>
      )}
      <DialogFooter>
        <Button variant="accent" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
