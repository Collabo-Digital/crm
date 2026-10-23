import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useReplaceRatesMutation } from "~/hooks/use-campaign-mutations";
import { useMessageRates } from "~/hooks/use-campaign-queries";
import type { MessageRate } from "~/types/api";

const EMPTY: MessageRate = { countryPrefix: "", label: "", currency: "INR", marketing: null, utility: null, authentication: null };

const num = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * The per-message rates from the business's own Meta rate card, for the
 * broadcast cost estimate. Meta publishes them per market and currency and
 * revises them each quarter, so Collabo does not ship numbers of its own.
 */
export function RatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data } = useMessageRates();
  const save = useReplaceRatesMutation();
  const [rows, setRows] = useState<MessageRate[]>([]);

  useEffect(() => {
    if (open) setRows(data?.length ? data : [{ ...EMPTY, countryPrefix: "91", label: "India" }, { ...EMPTY, countryPrefix: "*", label: "Everywhere else", currency: "USD" }]);
  }, [open, data]);

  const set = (i: number, patch: Partial<MessageRate>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Message rates</DialogTitle>
          <DialogDescription>
            Copy the per-message rates from your Meta rate card (WhatsApp Manager → Pricing, or Meta’s pricing page). They are used only to estimate
            what a broadcast will cost. Use the country calling code, or * for every other country.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-caption text-muted-foreground">
                <th className="pb-2 font-medium">Code</th>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Currency</th>
                <th className="pb-2 font-medium">Marketing</th>
                <th className="pb-2 font-medium">Utility</th>
                <th className="pb-2 font-medium">Authentication</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <Input className="h-8 w-16" value={row.countryPrefix} onChange={(e) => set(i, { countryPrefix: e.target.value.replace(/[^\d*]/g, "").slice(0, 4) })} aria-label="Country code" />
                  </td>
                  <td className="py-1 pr-2">
                    <Input className="h-8" value={row.label ?? ""} onChange={(e) => set(i, { label: e.target.value })} aria-label="Name" />
                  </td>
                  <td className="py-1 pr-2">
                    <Input className="h-8 w-20" value={row.currency} maxLength={3} onChange={(e) => set(i, { currency: e.target.value.toUpperCase() })} aria-label="Currency" />
                  </td>
                  {(["marketing", "utility", "authentication"] as const).map((k) => (
                    <td key={k} className="py-1 pr-2">
                      <Input
                        className="h-8 w-24"
                        type="number"
                        min={0}
                        step="0.0001"
                        value={row[k] ?? ""}
                        onChange={(e) => set(i, { [k]: num(e.target.value) })}
                        aria-label={`${k} rate`}
                      />
                    </td>
                  ))}
                  <td className="py-1">
                    <Button variant="ghost" size="icon-xs" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label="Remove row">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRows((r) => [...r, { ...EMPTY }])}>
            <Plus />
            Add a country
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={save.isPending || rows.some((r) => !r.countryPrefix || r.currency.length !== 3)}
            onClick={() => save.mutate(rows, { onSuccess: () => onOpenChange(false) })}
          >
            Save rates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
