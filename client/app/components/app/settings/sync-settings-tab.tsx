import { useEffect, useId, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { PaymentsCard } from "~/components/app/settings/payments-card";
import { Switch } from "~/components/ui/switch";
import {
  useOrganizationSettings,
} from "~/hooks/use-settings-queries";
import {
  useUpdateProductSettingsMutation,
  useUpdateOrderSettingsMutation,
  useUpdateInventorySettingsMutation,
} from "~/hooks/use-settings-mutations";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useUpdateOrganizationMutation } from "~/hooks/use-org-mutations";
import type { InventorySettings, ProductSettings } from "~/types/api";

/**
 * Combined "Products" and "Orders" settings panes. Each domain has one toggle
 * today (auto-sync to Shopify); the layout is built to absorb additional rows
 * cleanly as we add more per-domain settings (default GST rate, default
 * status, etc.). Two distinct tabs renders this same component with a
 * `domain` prop so the surface area stays small.
 */
export function ProductSettingsTab() {
  const { data, isLoading } = useOrganizationSettings();
  const mutation = useUpdateProductSettingsMutation();
  const { role } = useCurrentRole();
  // PATCH /organization/settings/products is ORG_MANAGERS on the server.
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const settings = data.productSettings;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
          Product settings
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Control how products created in the CRM behave when a Shopify channel is connected.
        </p>
        {!canManage && (
          <p className="mt-1 text-xs text-muted-foreground">
            Only an owner, admin or manager can change the switches below.
          </p>
        )}
      </div>

      <SettingsCard>
        <SettingsToggleRow
          label="Auto-sync new products to Shopify"
          help="When ON, every product created in the CRM is pushed to your connected Shopify store immediately. When OFF (default), products stay local until you sync them manually from the product page or via the channels-page Sync button."
          checked={settings.autoSyncToShopify}
          disabled={!canManage || isFieldSaving(mutation, "autoSyncToShopify")}
          onChange={(checked) => mutation.mutate({ autoSyncToShopify: checked })}
        />
        <SettingsToggleRow
          label="Track quantity (all products)"
          help="When ON, every variant tracks inventory regardless of its individual setting — stock decrements on offline orders and Shopify pushes set inventory_management=shopify. Combine with the option below if you want to track but still allow overselling. Turn OFF (default) to honor each variant's per-row setting."
          checked={settings.trackQuantityGlobally}
          disabled={!canManage || isFieldSaving(mutation, "trackQuantityGlobally")}
          onChange={(checked) => mutation.mutate({ trackQuantityGlobally: checked })}
        />
        <SettingsToggleRow
          label="Continue selling when out of stock (all products)"
          help="When ON, every variant in your catalog is treated as continue-selling — offline orders accept lines even when stock is 0, and Shopify pushes use inventory_policy=continue across the board. The per-variant toggle on individual products becomes redundant. Turn OFF to honor each variant's setting individually (default)."
          checked={settings.allowOversellGlobally}
          disabled={!canManage || isFieldSaving(mutation, "allowOversellGlobally")}
          onChange={(checked) => mutation.mutate({ allowOversellGlobally: checked })}
        />
        <LowStockThresholdRow />
        <VendorMetafieldRow settings={settings} mutation={mutation} canManage={canManage} />
      </SettingsCard>
      <BarcodePushCard />
    </div>
  );
}

/**
 * Multi-vendor routing config. Toggle to read each product's vendor from a
 * Shopify product metafield (e.g. `custom.vendor_shop_domain`) into
 * Product.vendorKey, which scopes VENDOR-role members. Built-in Product.vendor
 * is the fallback. Namespace/key commit on blur.
 */
function VendorMetafieldRow({
  settings,
  mutation,
  canManage,
}: {
  settings: ProductSettings;
  mutation: ReturnType<typeof useUpdateProductSettingsMutation>;
  canManage: boolean;
}) {
  const [namespace, setNamespace] = useState(settings.vendorMetafieldNamespace ?? "custom");
  const [key, setKey] = useState(settings.vendorMetafieldKey ?? "vendor_shop_domain");

  useEffect(() => setNamespace(settings.vendorMetafieldNamespace ?? "custom"), [settings.vendorMetafieldNamespace]);
  useEffect(() => setKey(settings.vendorMetafieldKey ?? "vendor_shop_domain"), [settings.vendorMetafieldKey]);
  const id = useId();

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p id={`${id}-label`} className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Identify vendor by product metafield
          </p>
          <p id={`${id}-help`} className="mt-1 text-caption text-muted-foreground leading-relaxed">
            When ON, product sync reads the metafield below into each product's vendor key, which is
            used to scope vendor accounts (their products + order lines). The built-in Shopify "Vendor"
            field is the fallback for untagged products. Re-sync products after enabling. Default OFF.
          </p>
        </div>
        <ToggleSwitch
          checked={settings.vendorMetafieldEnabled}
          disabled={!canManage || isFieldSaving(mutation, "vendorMetafieldEnabled")}
          onChange={(checked) => mutation.mutate({ vendorMetafieldEnabled: checked })}
          labelledBy={`${id}-label`}
          describedBy={`${id}-help`}
        />
      </div>
      {settings.vendorMetafieldEnabled && (
        <div className="flex items-center gap-2">
          <input
            disabled={!canManage}
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            onBlur={() =>
              namespace && namespace !== settings.vendorMetafieldNamespace &&
              mutation.mutate({ vendorMetafieldNamespace: namespace })
            }
            placeholder="namespace (e.g. custom)"
            aria-label="Metafield namespace"
            className="h-8 flex-1 rounded-lg border border-input bg-white px-3 text-xs dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-[#cdff8c]"
          />
          <span className="text-xs text-muted-foreground">.</span>
          <input
            disabled={!canManage}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={() =>
              key && key !== settings.vendorMetafieldKey &&
              mutation.mutate({ vendorMetafieldKey: key })
            }
            placeholder="key (e.g. vendor_shop_domain)"
            aria-label="Metafield key"
            className="h-8 flex-1 rounded-lg border border-input bg-white px-3 text-xs dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-[#cdff8c]"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Inline editor for `Organization.lowStockThreshold` — the number that drives
 * the "Low stock" stat card on the dashboard, the Low-stock products panel,
 * and the `?stockStatus=low_stock` product filter on the list page. Lives in
 * the Products settings tab because it's a product-domain concern, even
 * though the value itself is stored on the Organization row (not in the
 * productSettings JSONB).
 *
 * Save semantics: blur or Enter commits; Escape reverts. We don't autosave on
 * every keystroke because a number input pumps changes per-digit.
 */
function LowStockThresholdRow() {
  const { data: org } = useCurrentOrg();
  const mutation = useUpdateOrganizationMutation(org?.id ?? "");
  const serverValue = org?.lowStockThreshold ?? 10;

  const [draft, setDraft] = useState<string>(String(serverValue));
  const [justSaved, setJustSaved] = useState(false);

  // Keep the input in sync when the server-side value changes (initial load,
  // settle of a saved mutation, etc.).
  useEffect(() => {
    setDraft(String(serverValue));
  }, [serverValue]);

  function commit() {
    const parsed = parseInt(draft, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      // Invalid input → snap back to the server value.
      setDraft(String(serverValue));
      return;
    }
    if (parsed === serverValue) return;
    mutation.mutate(
      { lowStockThreshold: parsed },
      {
        onSuccess: () => {
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 1500);
        },
      },
    );
  }

  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex-1 min-w-0">
        <label htmlFor="low-stock-threshold" className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Low-stock alert threshold
        </label>
        <p className="mt-1 text-caption text-muted-foreground leading-relaxed">
          Variants whose stock is at or below this number are flagged as "low
          stock" on the dashboard, in the Low-stock panel, and in the products
          list "Low stock" filter. Out-of-stock items (≤ 0) are counted
          separately. Default is 10.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {mutation.isPending ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : justSaved ? (
          <Check className="size-3.5 text-green-600" />
        ) : null}
        <input
          id="low-stock-threshold"
          type="number"
          min={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(String(serverValue));
              e.currentTarget.blur();
            }
          }}
          disabled={mutation.isPending || !org?.id}
          className="h-8 w-20 rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-right text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-[#cdff8c] disabled:opacity-50"
        />
      </div>
    </div>
  );
}

/**
 * True when a mutation is in-flight AND the in-flight call carried a value
 * for `field`. Lets two toggle rows that share a single mutation hook gray
 * out only the row that's currently saving — otherwise clicking one toggle
 * dims the other, which reads as "the other turned off."
 */
function isFieldSaving<F extends string>(
  mutation: { isPending: boolean; variables?: Record<string, unknown> | unknown },
  field: F,
): boolean {
  if (!mutation.isPending) return false;
  const vars = mutation.variables;
  if (!vars || typeof vars !== "object") return false;
  return field in (vars as Record<string, unknown>);
}

export function OrderSettingsTab() {
  const { data, isLoading } = useOrganizationSettings();
  const mutation = useUpdateOrderSettingsMutation();

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const settings = data.orderSettings;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
          Order settings
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Control how offline (in-store) orders and draft orders created in the CRM behave when a Shopify channel is connected.
        </p>
      </div>

      <SettingsCard>
        <SettingsToggleRow
          label="Auto-sync new offline orders and drafts to Shopify"
          help="When ON, every offline order and draft order created in the CRM is pushed to your connected Shopify store immediately. When OFF (default), they stay local until you sync them manually or via the channels-page Sync button."
          checked={settings.autoSyncToShopify}
          disabled={isFieldSaving(mutation, "autoSyncToShopify")}
          onChange={(checked) => mutation.mutate({ autoSyncToShopify: checked })}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsToggleRow
          label="Auto-generate GST invoices for paid Shopify orders"
          help="When ON, a GST invoice is issued automatically as soon as a Shopify order is paid — not when it is placed, so abandoned and cancelled orders never consume an invoice number. Offline orders are unaffected; they are already invoiced when you create them. Requires GST enabled with a GSTIN registered under Tax & GST. Existing orders are not invoiced retroactively, and a bulk channel sync never triggers this."
          checked={settings.autoInvoiceOnPayment}
          disabled={isFieldSaving(mutation, "autoInvoiceOnPayment")}
          onChange={(checked) =>
            mutation.mutate({ autoInvoiceOnPayment: checked })
          }
        />
        <SettingsToggleRow
          label="Invoice cash-on-delivery orders when they ship"
          help="GST expects the tax invoice to be issued by the time the goods leave, but a cash-on-delivery order is only paid after delivery. When ON, a COD order gets its GST invoice as soon as it is fulfilled — in Shopify or from Shipments in the CRM — and the later payment issues nothing more. Prepaid orders are left to the setting above. Requires GST enabled with a GSTIN registered under Tax & GST."
          checked={settings.autoInvoiceCodOnShipping}
          disabled={isFieldSaving(mutation, "autoInvoiceCodOnShipping")}
          onChange={(checked) =>
            mutation.mutate({ autoInvoiceCodOnShipping: checked })
          }
        />
      </SettingsCard>

      <PaymentsCard />

      <p className="text-xs text-muted-foreground">
        To send every customer their invoice as a PDF on WhatsApp once it is issued, start the “Send the GST invoice” playbook in{" "}
        <Link to="/campaigns/automations" className="font-medium text-foreground underline">
          Automations
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * Whether barcodes the CRM generated ride along on Shopify product pushes.
 *
 * Lives on the Products tab rather than an Inventory one because it is about
 * what leaves the CRM for Shopify, which is what every other toggle on this
 * tab governs. It reads `inventorySettings` because that is where the server
 * keeps it (alongside the SKU sequence that mints the codes).
 *
 * Default OFF is the safe direction: a generated barcode is an internal number,
 * not a GTIN, and the Shopify push serialises the whole variant row — so
 * without the gate it would quietly occupy the field a real GTIN belongs in.
 */
function BarcodePushCard() {
  const { data } = useOrganizationSettings();
  const mutation = useUpdateInventorySettingsMutation();
  const settings = data?.inventorySettings;
  if (!settings) return null;

  return (
    <SettingsCard>
      <SkuPrefixRow settings={settings} mutation={mutation} />
      <SettingsToggleRow
        label="Send generated barcodes to Shopify"
        help="The CRM gives products a short numeric barcode so they can be printed on small and jewellery label stock, where a full SKU is too long to scan. When ON, that code is included when a product is pushed to Shopify, so Shopify POS can scan the same labels. When OFF (default), it stays in the CRM and your Shopify barcode field is left untouched — the right choice if you may assign real GTINs later. Barcodes that came from Shopify or that you typed yourself are always sent, either way."
        checked={settings.pushGeneratedBarcodes}
        disabled={isFieldSaving(mutation, "pushGeneratedBarcodes")}
        onChange={(checked) => mutation.mutate({ pushGeneratedBarcodes: checked })}
      />
    </SettingsCard>
  );
}

/**
 * SKU prefix — the code generated SKUs start with.
 *
 * The generator builds `{PREFIX}-{PRODUCT}-{SEQ}-{OPTIONS}`, so "SJ" yields
 * SJ-SAR-001-BLK. Left blank it derives a three-letter prefix from the
 * organization name instead, which is the existing behaviour.
 *
 * Letters and digits only, matching the server rule: the parts are joined with
 * "-", so punctuation here would produce a code that cannot be read back.
 * Committed on blur rather than per keystroke, like the fields above.
 */
function SkuPrefixRow({
  settings,
  mutation,
}: {
  settings: InventorySettings;
  mutation: ReturnType<typeof useUpdateInventorySettingsMutation>;
}) {
  const serverPrefix = settings.skuPrefix ?? "";
  const [draft, setDraft] = useState(serverPrefix);

  useEffect(() => setDraft(serverPrefix), [serverPrefix]);

  const candidate = draft.trim().toUpperCase();
  const invalid = !/^[A-Z0-9]{0,10}$/.test(candidate);

  function commit() {
    if (invalid) {
      setDraft(serverPrefix);
      return;
    }
    if (candidate === serverPrefix) return;
    mutation.mutate({ skuPrefix: candidate });
  }

  return (
    <div className="space-y-2 px-5 py-4">
      <div className="min-w-0">
        {/* A real label, not a placeholder: a placeholder alone leaves the
            input with no accessible name. */}
        <label
          htmlFor="sku-prefix"
          className="text-sm font-medium text-gray-900 dark:text-gray-100"
        >
          SKU prefix
        </label>
        <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
          The code generated SKUs begin with — enter SJ and a saree becomes
          SJ-SAR-001. Letters and digits only, up to 10. Leave it empty to use a
          short code derived from your business name. Existing SKUs are not
          renamed.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="sku-prefix"
          value={draft}
          maxLength={10}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(serverPrefix);
              e.currentTarget.blur();
            }
          }}
          placeholder="e.g. SJ"
          className="h-8 w-28 rounded-lg border border-input bg-white px-3 font-mono text-xs uppercase focus:outline-none focus:ring-2 focus:ring-[#cdff8c] dark:bg-gray-800"
        />
        <span className="font-mono text-xs text-muted-foreground">
          {(candidate || "———") + "-SAR-001"}
        </span>
        {isFieldSaving(mutation, "skuPrefix") && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
      {invalid && (
        <p className="text-caption text-danger-text">
          Letters and digits only, with no spaces or punctuation.
        </p>
      )}
    </div>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border divide-y">
      {children}
    </section>
  );
}

/**
 * One labeled toggle row. Designed to repeat — drop more `<SettingsToggleRow>`
 * inside a `<SettingsCard>` as new settings get added to a domain.
 */
function SettingsToggleRow({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex-1 min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </p>
        {help && (
          <p id={`${id}-help`} className="mt-1 text-caption text-muted-foreground leading-relaxed">
            {help}
          </p>
        )}
      </div>
      <ToggleSwitch
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        labelledBy={`${id}-label`}
        describedBy={help ? `${id}-help` : undefined}
      />
    </div>
  );
}

/** `labelledBy` and `describedBy` are the ids of the row's title and help text. */
function ToggleSwitch({
  checked,
  disabled,
  onChange,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    />
  );
}
