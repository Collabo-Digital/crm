import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateTaxSettingsMutation } from "~/hooks/use-settings-mutations";
import { COMMON_UQC } from "~/lib/gst-uqc";

/**
 * GST return settings — the two values that shape the filed return.
 *
 * Both change STATUTORY OUTPUT, which is why the server route is role-gated:
 * the threshold moves invoices between GSTR-1 table 5 and table 7, and the UQC
 * appears on every table 12 row.
 */
export function GstReturnSettings() {
  const { data: settings, isLoading } = useOrganizationSettings();
  const mutation = useUpdateTaxSettingsMutation();

  const serverThreshold = settings?.taxSettings?.b2cLargeThreshold ?? 100000;
  const serverUqc = settings?.taxSettings?.defaultUnitOfMeasure ?? "NOS";

  // Uncontrolled draft, committed on blur or Enter — a number input fires a
  // change per digit, so saving on every keystroke would PATCH "1", "10",
  // "100"... and briefly persist each one.
  const [draft, setDraft] = useState(String(serverThreshold));
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(String(serverThreshold));
  }, [serverThreshold]);

  function commitThreshold() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(serverThreshold));
      return;
    }
    if (parsed === serverThreshold) return;

    mutation.mutate(
      { b2cLargeThreshold: parsed },
      {
        onSuccess: () => {
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 1500);
        },
      },
    );
  }

  if (isLoading) return null;

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-border dark:bg-gray-900">
      <div className="border-b pb-4">
        <h3 className="text-body font-semibold text-foreground">GST returns</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">
          How supplies are grouped in the filed GSTR-1.
        </p>
      </div>

      <div className="mt-4 space-y-5">
        <div className="sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
          <label
            htmlFor="b2cl-threshold"
            className="text-caption font-medium text-foreground"
          >
            B2C large-invoice threshold
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              Inter-state consumer invoices ABOVE this value are reported
              invoice-wise in table 5; the rest are summarised in table 7. The
              statutory figure is ₹1,00,000 (reduced from ₹2,50,000 in November
              2024) — confirm with your accountant before changing it.
            </span>
          </label>
          <div className="mt-1 flex items-center gap-2 sm:col-span-2 sm:mt-0">
            <input
              id="b2cl-threshold"
              type="number"
              min="1"
              step="1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setDraft(String(serverThreshold));
                  e.currentTarget.blur();
                }
              }}
              className="h-9 w-40 rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            {mutation.isPending && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            {justSaved && <Check className="size-3.5 text-success" />}
          </div>
        </div>

        <div className="sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
          <label className="text-caption font-medium text-foreground">
            Tax delivery charges
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              Treats delivery as a composite supply, taxed at the rate of the
              goods. Correct under GST, and until now shipping was added to the
              total untaxed — so every shipped order under-declared tax.
              <br />
              <strong className="text-warning">
                This changes tax charged on new orders.
              </strong>{" "}
              For Shopify orders the customer was already charged at checkout, so
              turn this on only once your store taxes shipping too — otherwise
              the invoice will declare more than you collected, and every shipped
              order will show a reconciliation mismatch.
            </span>
          </label>
          <div className="mt-1 sm:col-span-2 sm:mt-0">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings?.taxSettings?.taxShipping ?? false}
                onChange={(e) =>
                  mutation.mutate({ taxShipping: e.target.checked })
                }
                className="size-4 rounded border-input"
              />
              <span className="text-caption">
                Tax shipping as part of the supply
              </span>
            </label>
          </div>
        </div>

        <div className="sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
          <label className="text-caption font-medium text-foreground">
            Default unit of quantity
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              Used on GSTR-1 table 12 rows for products that do not specify one.
              Table 12 requires a unit on every row, so this is what keeps the
              table valid before the catalogue is fully classified.
            </span>
          </label>
          <div className="mt-1 sm:col-span-2 sm:mt-0">
            <Select
              value={serverUqc}
              onValueChange={(next) =>
                mutation.mutate({ defaultUnitOfMeasure: next })
              }
            >
              <SelectTrigger aria-label="Default unit of quantity" className="h-9 w-56 text-caption">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMON_UQC.map((u) => (
                  <SelectItem key={u.code} value={u.code} className="text-caption">
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
