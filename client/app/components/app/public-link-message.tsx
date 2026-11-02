import type { LucideIcon } from "lucide-react";
import { RotateCw } from "lucide-react";

import { Button } from "~/components/ui/button";

/** A public link page's one message: a link that is wrong, an order already placed, a failed load. */
export function PublicLinkMessage({
  icon: Icon,
  title,
  body,
  retry,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Only for failures a second try can fix; a wrong link stays wrong. */
  retry?: { onClick: () => void; busy: boolean };
}) {
  return (
    <div className="flex flex-col items-center gap-3 pt-16 text-center">
      <Icon className="size-10 text-muted-foreground" />
      <h1 className="font-heading text-subhead">{title}</h1>
      <p className="text-body text-muted-foreground">{body}</p>
      {retry && (
        <Button variant="outline" className="h-11" disabled={retry.busy} onClick={retry.onClick}>
          <RotateCw />
          Try again
        </Button>
      )}
    </div>
  );
}
