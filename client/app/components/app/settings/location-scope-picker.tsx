import { useState } from "react";
import { Loader2, MapPin } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { LocationKindBadge } from "~/components/app/inventory/location-kind-badge";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useUpdateMemberLocationsMutation } from "~/hooks/use-org-mutations";
import {
  isLocationScopedRole,
  locationScopeLabel,
  scopeOptions,
  startLimiting,
  toggleLocation,
  usesStockLocations,
} from "~/lib/location-scope";
import { roleLabel } from "~/lib/labels";
import { cn } from "~/lib/utils";
import type { OrgMember, UserRole } from "~/types/api";

/**
 * "Stores this member works at": every location, or only the ones ticked.
 * For Managers and Agents in a workspace with stock locations; renders
 * nothing otherwise. An empty `value` means every location, so the last
 * ticked location cannot be unticked — "every location" is its own choice.
 */
export function LocationScopePicker({
  role,
  value,
  onChange,
  disabled,
  showTitle = true,
}: {
  role: UserRole;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  showTitle?: boolean;
}) {
  const warehouses = useWarehouses();
  if (!isLocationScopedRole(role) || !usesStockLocations(warehouses.data)) return null;
  const options = scopeOptions(warehouses.data ?? [], value);
  const limited = value.length > 0;

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className={cn("mb-1.5 text-caption font-medium text-muted-foreground", !showTitle && "sr-only")}>
        Stores this member works at
      </legend>
      <RadioGroup
        value={limited ? "some" : "all"}
        onValueChange={(mode) => onChange(mode === "all" ? [] : startLimiting(options))}
        disabled={disabled}
        className="gap-1.5"
      >
        <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
          <RadioGroupItem value="all" />
          Every store and warehouse
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
          <RadioGroupItem value="some" />
          Only the ones I tick
        </label>
      </RadioGroup>
      {limited && (
        <div className="grid gap-x-4 gap-y-2 pl-6 sm:grid-cols-2">
          {options.map((option) => {
            const checked = value.includes(option.id);
            return (
              <label key={option.id} className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-foreground">
                <Checkbox
                  checked={checked}
                  disabled={disabled || (checked && value.length === 1)}
                  onCheckedChange={(next) => onChange(toggleLocation(value, option.id, next === true))}
                />
                <span className="min-w-0 truncate" title={option.name}>
                  {option.name}
                  {!option.isActive && <span className="text-muted-foreground"> (switched off)</span>}
                </span>
                <LocationKindBadge kind={option.kind} />
              </label>
            );
          })}
        </div>
      )}
      <p className="text-caption text-muted-foreground">
        {limited
          ? "They bill, see and change stock, and pack orders only at these. Every online order stays visible to them."
          : "They can bill, see and change stock, and pack orders at every location."}
      </p>
    </fieldset>
  );
}

/**
 * The member row's stores button, for Owners and Admins: what the member works
 * at, and a dialog to change it. Managers and Agents only, in a workspace with
 * stock locations; renders nothing otherwise.
 */
export function MemberLocationScope({ orgId, member }: { orgId: string; member: OrgMember }) {
  const warehouses = useWarehouses();
  const [open, setOpen] = useState(false);
  if (!isLocationScopedRole(member.role) || !usesStockLocations(warehouses.data)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Stores ${member.user.firstName} works at: ${locationScopeLabel(member.locationScope, warehouses.data ?? [])}`}
        className="inline-flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-md border border-input bg-card px-2 text-caption font-medium text-muted-foreground hover:text-foreground transition-colors max-md:h-11 max-md:px-3"
      >
        <MapPin className="size-3 shrink-0" />
        <span className="truncate">{locationScopeLabel(member.locationScope, warehouses.data ?? [])}</span>
      </button>
      {open && <MemberLocationScopeDialog orgId={orgId} member={member} onClose={() => setOpen(false)} />}
    </>
  );
}

function MemberLocationScopeDialog({ orgId, member, onClose }: { orgId: string; member: OrgMember; onClose: () => void }) {
  const [scope, setScope] = useState<string[]>(() => member.locationScope ?? []);
  const update = useUpdateMemberLocationsMutation(orgId);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stores {member.user.firstName} works at</DialogTitle>
          <DialogDescription>
            Limit {member.user.firstName} ({roleLabel(member.role)}) to the stores and warehouses they work at.
          </DialogDescription>
        </DialogHeader>
        <LocationScopePicker role={member.role} value={scope} onChange={setScope} disabled={update.isPending} showTitle={false} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={update.isPending}
            onClick={() => update.mutate({ memberId: member.id, locationScope: scope }, { onSuccess: onClose })}
          >
            {update.isPending && <Loader2 className="animate-spin" />}
            Save stores
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
