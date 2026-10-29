import { useState } from "react";

import { SaveBar } from "~/components/app/save-bar";
import { ConfirmChangeDialog } from "~/components/app/settings/confirm-change-dialog";
import { DEFAULT_PREFIX, InvoiceSeriesSetting, invoicePrefixError } from "~/components/app/settings/invoice-series-setting";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateTaxSettingsMutation } from "~/hooks/use-settings-mutations";
import { COMMON_UQC } from "~/lib/gst-uqc";
import type { UpdateTaxSettingsRequest } from "~/types/api";

interface Draft {
  threshold: string;
  uqc: string;
  prefix: string;
}

/**
 * GST returns and invoice numbering — the typed values that shape the filed
 * return and every invoice number. One form with one Save, like every other
 * settings form; "Tax shipping" is a switch, so it saves when flipped, after
 * saying what it changes.
 *
 * All of it is STATUTORY OUTPUT, which is why the server route is role-gated:
 * the threshold moves invoices between GSTR-1 table 5 and table 7, the UQC
 * appears on every table 12 row, and the prefix starts a new invoice series.
 */
export function GstReturnSettings() {
  const { data: settings, isLoading } = useOrganizationSettings();
  const save = useUpdateTaxSettingsMutation();
  const shipping = useUpdateTaxSettingsMutation();
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS
  const [draft, setDraft] = useState<Draft | null>(null);
  const [askShipping, setAskShipping] = useState<boolean | null>(null);

  if (isLoading || !settings) return null;

  const saved: Draft = {
    threshold: String(settings.taxSettings.b2cLargeThreshold ?? 100000),
    uqc: settings.taxSettings.defaultUnitOfMeasure ?? "NOS",
    prefix: settings.taxSettings.invoicePrefix ?? DEFAULT_PREFIX,
  };
  const form = draft ?? saved;
  const set = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });

  const threshold = Number(form.threshold);
  const thresholdError = !Number.isFinite(threshold) || threshold <= 0 ? "Enter an amount above zero." : null;
  const prefix = form.prefix.trim().toUpperCase();
  const prefixError = invoicePrefixError(prefix);

  const patch: UpdateTaxSettingsRequest = {
    ...(form.threshold.trim() !== saved.threshold && { b2cLargeThreshold: threshold }),
    ...(form.uqc !== saved.uqc && { defaultUnitOfMeasure: form.uqc }),
    ...(prefix !== saved.prefix && { invoicePrefix: prefix }),
  };
  const dirty = Object.keys(patch).length > 0;
  const taxShipping = settings.taxSettings.taxShipping ?? false;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || thresholdError || prefixError) return;
        save.mutate(patch, { onSuccess: () => setDraft(null) });
      }}
    >
      <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border">
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
              <span className="mt-0.5 block text-caption font-normal text-muted-foreground">
                Inter-state consumer invoices ABOVE this value are reported
                invoice-wise in table 5; the rest are summarised in table 7. The
                statutory figure is ₹1,00,000 (reduced from ₹2,50,000 in November
                2024) — confirm with your accountant before changing it.
              </span>
            </label>
            <div className="mt-1 sm:col-span-2 sm:mt-0">
              <Input
                id="b2cl-threshold"
                type="number"
                min="1"
                step="1"
                value={form.threshold}
                disabled={!canManage}
                aria-invalid={!!thresholdError || undefined}
                onChange={(e) => set({ threshold: e.target.value })}
                className="w-40"
              />
              {thresholdError && <p className="mt-1.5 text-caption text-danger-text">{thresholdError}</p>}
            </div>
          </div>

          <div className="flex items-start justify-between gap-4 sm:grid sm:grid-cols-3 sm:gap-4">
            <label htmlFor="tax-shipping" className="min-w-0 text-caption font-medium text-foreground">
              Tax delivery charges
              <span className="mt-0.5 block text-caption font-normal text-muted-foreground">
                Charges GST on delivery at the rate of the goods, because GST
                treats delivery as part of the same supply. Shopify customers
                pay at checkout, so turn this on only once your Shopify store
                taxes shipping too, or your invoices will declare more tax than
                you collected.
              </span>
            </label>
            <div className="shrink-0 sm:col-span-2">
              <Switch
                id="tax-shipping"
                checked={taxShipping}
                disabled={!canManage || shipping.isPending}
                onCheckedChange={(on) => setAskShipping(on)}
              />
            </div>
          </div>

          <div className="sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
            <label htmlFor="default-uqc" className="text-caption font-medium text-foreground">
              Default unit of quantity
              <span className="mt-0.5 block text-caption font-normal text-muted-foreground">
                Used on GSTR-1 table 12 rows for products that do not specify one.
                Table 12 requires a unit on every row, so this is what keeps the
                table valid before the catalogue is fully classified.
              </span>
            </label>
            <div className="mt-1 sm:col-span-2 sm:mt-0">
              <Select value={form.uqc} onValueChange={(next) => set({ uqc: next })} disabled={!canManage}>
                <SelectTrigger id="default-uqc" aria-label="Default unit of quantity" className="h-9 w-56 text-caption">
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

      <InvoiceSeriesSetting
        value={form.prefix}
        savedPrefix={saved.prefix}
        readOnly={!canManage}
        onChange={(next) => set({ prefix: next })}
      />

      {canManage && (
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          invalid={!!thresholdError || !!prefixError}
          onDiscard={() => setDraft(null)}
          what="the GST settings"
        />
      )}

      <ConfirmChangeDialog
        open={askShipping !== null}
        title={askShipping ? "Charge GST on delivery?" : "Stop charging GST on delivery?"}
        points={
          askShipping
            ? [
                "New orders charge GST on delivery, at the rate of the goods.",
                "Invoices for Shopify orders declare that GST, so your Shopify store should charge it at checkout too.",
                "Orders and invoices already made don't change.",
              ]
            : ["New orders charge no GST on delivery.", "Orders and invoices already made don't change."]
        }
        confirmLabel={askShipping ? "Charge GST on delivery" : "Stop charging it"}
        onCancel={() => setAskShipping(null)}
        onConfirm={() => {
          if (askShipping !== null) shipping.mutate({ taxShipping: askShipping });
          setAskShipping(null);
        }}
      />
    </form>
  );
}
