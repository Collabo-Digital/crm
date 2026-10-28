import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateStoreProfileSettingsMutation } from "~/hooks/use-settings-mutations";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import type { StoreProfileSettings } from "~/types/api";

/**
 * The merchant's own business identity — what prints in the "From" block and
 * contact row of a package slip.
 *
 * This is a FORM, not a row of toggles: the fields are edited together and
 * saved once, so it holds local draft state and PATCHes on submit (the
 * mutation has no optimistic update for the same reason). Everything is
 * optional; a blank field falls back rather than printing empty — the help
 * text under each group says what to.
 */

const FIELDS: ReadonlyArray<{
  key: keyof StoreProfileSettings;
  label: string;
  placeholder?: string;
  /** Renders in the two-column grid rather than full width. */
  half?: boolean;
}> = [
  { key: "storeName", label: "Trading name", placeholder: "Your store name" },
  { key: "address1", label: "Address line 1", placeholder: "Building, street" },
  { key: "address2", label: "Address line 2", placeholder: "Area, landmark (optional)" },
  { key: "city", label: "City", half: true, placeholder: "City" },
  { key: "province", label: "State / province", half: true, placeholder: "State" },
  { key: "zip", label: "PIN / postcode", half: true, placeholder: "PIN / postcode" },
  { key: "country", label: "Country", half: true, placeholder: "Country" },
  { key: "supportPhone", label: "Phone", half: true, placeholder: "+91 XXXXX XXXXX" },
  { key: "whatsappPhone", label: "WhatsApp", half: true, placeholder: "+91 XXXXX XXXXX" },
  { key: "supportEmail", label: "Support email", half: true, placeholder: "support@yourstore.com" },
  { key: "website", label: "Website", half: true, placeholder: "https://yourstore.com" },
  { key: "logoUrl", label: "Logo URL", placeholder: "https://yourstore.com/logo.png" },
];

export function StoreProfileTab() {
  const { data, isLoading } = useOrganizationSettings();
  const { data: org } = useCurrentOrg();
  const mutation = useUpdateStoreProfileSettingsMutation();

  const [draft, setDraft] = useState<StoreProfileSettings | null>(null);
  const { hash } = useLocation();

  // Seed the draft once the server value arrives, and re-seed after a save so
  // the form shows the canonicalised (trimmed) values the server kept.
  const saved = data?.storeProfileSettings;
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  // A link to one field (the invoice settings' checklist) lands on it. The
  // form appears only once the settings load, after the router has scrolled.
  const ready = draft !== null;
  useEffect(() => {
    if (!ready || !hash.startsWith("#store-")) return;
    const field = document.getElementById(hash.slice(1));
    field?.scrollIntoView({ block: "center" });
    field?.focus({ preventScroll: true });
  }, [ready, hash]);

  if (isLoading || !draft) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const set = (key: keyof StoreProfileSettings, value: string) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const dirty = Boolean(saved) && FIELDS.some((f) => draft[f.key] !== saved![f.key]);

  const inputCls =
    "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring";

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(draft);
      }}
    >
      <div>
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Store profile</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Printed as the “From” address and contact details on package slips. Leave a field blank
          to fall back: the trading name, website and logo fall back to your workspace’s, and the
          address falls back to your default GSTIN’s registered address.
        </p>
      </div>

      <section className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-border dark:bg-gray-900">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className={field.half ? "" : "sm:col-span-2"}>
              <label htmlFor={`store-${field.key}`} className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                {field.label}
              </label>
              <input
                id={`store-${field.key}`}
                value={draft[field.key]}
                onChange={(e) => set(field.key, e.target.value)}
                placeholder={field.placeholder}
                className={inputCls}
              />
            </div>
          ))}
        </div>

        {draft.logoUrl && (
          <div className="mt-4 flex items-center gap-3 border-t pt-4">
            <span className="text-xs text-muted-foreground">Preview</span>
            <img
              src={draft.logoUrl}
              alt=""
              className="h-9 w-auto max-w-[140px] object-contain"
              // A broken URL is the likeliest mistake here, and the slip drops
              // the logo silently — so say so before it reaches a printer.
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          {mutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Save store profile
        </button>
        {!org?.gstEnabled && !draft.address1 && (
          <p className="text-xs text-amber-700">
            GST is off, so there is no GSTIN address to fall back to — fill the address in here or
            the slip’s From block will be blank.
          </p>
        )}
      </div>
    </form>
  );
}
