import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateTaxSettingsMutation } from "~/hooks/use-settings-mutations";

type Scheme = "composition" | "eInvoicing";

const SCHEMES: Record<Scheme, { label: string; hint: string; confirm: string; points: string[] }> = {
  composition: {
    label: "Composition scheme",
    hint:
      "For sellers registered under the composition scheme, who can't charge GST. Invoices and point of sale bills become Bills of Supply with no GST on them, and sales to another state are refused, because the scheme doesn't allow them.",
    confirm: "Turn on the composition scheme?",
    points: [
      "Every invoice and point of sale bill is a Bill of Supply, with no GST charged.",
      "Sales to customers in another state are refused.",
      "Your GST returns are CMP-08 and GSTR-4, not GSTR-1 and GSTR-3B.",
      "Invoices already issued don't change.",
    ],
  },
  eInvoicing: {
    label: "E-invoicing (turnover above ₹5 crore)",
    hint:
      "For businesses whose turnover went above ₹5 crore in any year since 2017-18. Their invoices to GST-registered buyers, and exports, need an IRN from the government's e-invoice portal, which Collabo can't get yet, so those are refused here and must be issued on the portal.",
    confirm: "Turn on e-invoicing?",
    points: [
      "Invoices and credit notes to GST-registered buyers, and exports, are refused here. Issue them on the e-invoice portal or in your accounting software.",
      "Invoices to consumers still issue here, with the declaration GST asks for.",
      "Invoices already issued don't change.",
    ],
  },
};

/**
 * Two switches that change which documents Collabo issues, so each asks
 * before turning on. They can't both be on (the composition limit is far
 * below the e-invoicing one): the server refuses that with its own sentence,
 * which the tax mutation shows. Manager-gated on the server, mirrored here.
 */
export function TaxSchemeSetting() {
  const { data: settings, isLoading } = useOrganizationSettings();
  const mutation = useUpdateTaxSettingsMutation();
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS
  const [asking, setAsking] = useState<Scheme | null>(null);

  if (isLoading || !settings) return null;

  const turn = (scheme: Scheme, on: boolean) =>
    mutation.mutate(scheme === "composition" ? { composition: on } : { eInvoicing: on });

  return (
    <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border">
      <div className="border-b pb-4">
        <h3 className="text-body font-semibold text-foreground">Composition and e-invoicing</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">Turn these on only if they apply to your GST registration.</p>
      </div>

      <div className="mt-4 space-y-5">
        {(Object.keys(SCHEMES) as Scheme[]).map((scheme) => (
          <div key={scheme} className="flex items-start justify-between gap-4">
            <label htmlFor={`tax-${scheme}`} className="min-w-0 text-caption font-medium text-foreground">
              {SCHEMES[scheme].label}
              <span className="mt-0.5 block text-micro font-normal text-muted-foreground">{SCHEMES[scheme].hint}</span>
            </label>
            <Switch
              id={`tax-${scheme}`}
              checked={settings.taxSettings[scheme]}
              disabled={!canManage || mutation.isPending}
              onCheckedChange={(on) => (on ? setAsking(scheme) : turn(scheme, false))}
            />
          </div>
        ))}
      </div>

      <Dialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent>
          {asking && (
            <>
              <DialogHeader>
                <DialogTitle>{SCHEMES[asking].confirm}</DialogTitle>
                <DialogDescription>From now on:</DialogDescription>
              </DialogHeader>
              <ul className="list-disc space-y-1.5 pl-5 text-body">
                {SCHEMES[asking].points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button
                  variant="brand"
                  onClick={() => {
                    turn(asking, true);
                    setAsking(null);
                  }}
                >
                  Turn on
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
