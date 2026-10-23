import { ChevronDown } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { PRESENCE_DOT } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxAvailability } from "~/types/api";

/**
 * The member's own availability. "Online" only counts while this inbox is
 * open and connected — closing the tab makes them offline for routing and the
 * team list without anyone having to remember to switch.
 */
export function AvailabilityMenu({
  status,
  connected,
  disabled,
  onChange,
}: {
  status: InboxAvailability | undefined;
  connected: boolean;
  disabled: boolean;
  onChange: (status: InboxAvailability) => void;
}) {
  const presence = !connected ? "offline" : status === "AWAY" ? "away" : "online";
  const label = !connected ? "Connecting…" : status === "AWAY" ? "Away" : "Online";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={`Your status: ${label}`} className="min-h-11 rounded-full px-3 text-xs md:min-h-0 md:rounded-lg md:px-2.5">
          <span className={cn("size-2 rounded-full", PRESENCE_DOT[presence])} />
          {label}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Away keeps you out of automatic assignment while you stay signed in.
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={status ?? "ONLINE"} onValueChange={(value) => onChange(value as InboxAvailability)}>
          <DropdownMenuRadioItem value="ONLINE">
            <span className={cn("size-2 rounded-full", PRESENCE_DOT.online)} />
            Online
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="AWAY">
            <span className={cn("size-2 rounded-full", PRESENCE_DOT.away)} />
            Away
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
