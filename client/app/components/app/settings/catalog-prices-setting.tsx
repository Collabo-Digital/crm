import { Switch } from "~/components/ui/switch";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateTaxSettingsMutation } from "~/hooks/use-settings-mutations";

/**
 * "Catalogue prices include GST" — whether GST is taken out of a price or
 * added on top of it, for WhatsApp carts, draft orders and counter sales.
 *
 * Until the merchant chooses, the server goes by the store's own Shopify
 * orders, so the switch starts there and says so. The tax route is
 * manager-gated on the server; the switch mirrors that rather than offering a
 * change that can only be refused.
 */
export function CatalogPricesSetting() {
  const { data: settings, isLoading } = useOrganizationSettings();
  const mutation = useUpdateTaxSettingsMutation();
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS

  if (isLoading || !settings) return null;

  const chosen = settings.taxSettings.pricesIncludeTax;
  const detected = settings.pricesIncludeTax.detected;

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-border dark:bg-gray-900">
      <div className="border-b pb-4">
        <h3 className="text-body font-semibold text-foreground">Prices and GST</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">
          Whether the prices you sell at already have GST in them.
        </p>
      </div>

      <div className="mt-4 flex items-start justify-between gap-4">
        <label htmlFor="prices-include-gst" className="min-w-0 text-caption font-medium text-foreground">
          Catalogue prices include GST
          <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
            Turn this on if your product prices already have GST in them. A
            ₹1,180 product at 18% is then billed ₹1,180, of which ₹180 is GST,
            instead of ₹1,392.40. This covers WhatsApp carts, draft orders and
            counter sales. Orders and drafts already saved keep their totals.
          </span>
          {chosen === null && detected !== null && (
            <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
              This was detected from your Shopify orders. Change it if it is wrong.
            </span>
          )}
        </label>
        <Switch
          id="prices-include-gst"
          aria-label="Catalogue prices include GST"
          checked={chosen ?? detected ?? false}
          disabled={!canManage || mutation.isPending}
          onCheckedChange={(next) => mutation.mutate({ pricesIncludeTax: next })}
        />
      </div>
    </div>
  );
}
