import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { SaveBar } from "~/components/app/save-bar";
import { LogoSection } from "~/components/app/settings/invoice-settings-sections";
import { Input } from "~/components/ui/input";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import {
  useRemoveLogoMutation,
  useUpdateStoreProfileSettingsMutation,
  useUploadLogoMutation,
} from "~/hooks/use-settings-mutations";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import type { StoreProfileSettings } from "~/types/api";

/**
 * The merchant's own business identity — what prints in the "From" block and
 * contact row of a package slip, and the one logo every printed document uses.
 *
 * This is a FORM, not a row of toggles: the fields are edited together and
 * saved once, so it holds local draft state and PATCHes on submit (the
 * mutation has no optimistic update for the same reason). Everything is
 * optional; a blank field falls back rather than printing empty — the help
 * text under each group says what to. The logo is an upload, which saves at
 * once like every file upload, and is the only place the logo is set.
 */

type Field = Exclude<keyof StoreProfileSettings, "logoUrl" | "logoStorageKey">;

const FIELDS: ReadonlyArray<{
  key: Field;
  label: string;
  placeholder?: string;
  /** Renders in the two-column grid rather than full width. */
  half?: boolean;
}> = [
  { key: "storeName", label: "Trading name", placeholder: "Your store name" },
  { key: "address1", label: "Address line 1", placeholder: "Building, street" },
  { key: "address2", label: "Address line 2", placeholder: "Area, landmark (optional)" },
  { key: "city", label: "City", half: true, placeholder: "City" },
  { key: "province", label: "State", half: true, placeholder: "State" },
  { key: "zip", label: "PIN code", half: true, placeholder: "PIN code" },
  { key: "country", label: "Country", half: true, placeholder: "Country" },
  { key: "supportPhone", label: "Phone", half: true, placeholder: "+91 XXXXX XXXXX" },
  { key: "whatsappPhone", label: "WhatsApp", half: true, placeholder: "+91 XXXXX XXXXX" },
  { key: "supportEmail", label: "Support email", half: true, placeholder: "support@yourstore.com" },
  { key: "website", label: "Website", half: true, placeholder: "https://yourstore.com" },
];

type Draft = Record<Field, string>;

const toDraft = (s: StoreProfileSettings): Draft =>
  Object.fromEntries(FIELDS.map((f) => [f.key, s[f.key]])) as Draft;

export function StoreProfileTab() {
  const { data, isLoading } = useOrganizationSettings();
  const { data: org } = useCurrentOrg();
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS
  const mutation = useUpdateStoreProfileSettingsMutation();
  const uploadLogo = useUploadLogoMutation();
  const removeLogo = useRemoveLogoMutation();

  // The form and the saved profile it started from. When the saved one
  // changes (a save, a logo upload), fields that weren't touched follow it and
  // typed ones are kept.
  const [form, setForm] = useState<{ base: Draft; draft: Draft } | null>(null);
  const { hash } = useLocation();

  const saved = data?.storeProfileSettings;
  useEffect(() => {
    if (!saved) return;
    const next = toDraft(saved);
    setForm((f) =>
      f
        ? { base: next, draft: Object.fromEntries(FIELDS.map(({ key }) => [key, f.draft[key] === f.base[key] ? next[key] : f.draft[key]])) as Draft }
        : { base: next, draft: next },
    );
  }, [saved]);

  // A link to one field (the invoice settings' checklist) lands on it. The
  // form appears only once the settings load, after the router has scrolled.
  const ready = form !== null;
  useEffect(() => {
    if (!ready || !hash.startsWith("#store-")) return;
    const field = document.getElementById(hash.slice(1));
    field?.scrollIntoView({ block: "center" });
    field?.focus({ preventScroll: true });
  }, [ready, hash]);

  if (isLoading || !form || !saved) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { base, draft } = form;
  const set = (key: Field, value: string) => setForm((f) => (f ? { ...f, draft: { ...f.draft, [key]: value } } : f));
  const patch = Object.fromEntries(FIELDS.filter(({ key }) => draft[key] !== base[key]).map(({ key }) => [key, draft[key]]));
  const dirty = Object.keys(patch).length > 0;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        // The server trims what it keeps, so the form starts again from that.
        if (dirty) mutation.mutate(patch, { onSuccess: (kept) => setForm({ base: toDraft(kept), draft: toDraft(kept) }) });
      }}
    >
      <div>
        <h2 className="text-section max-md:hidden">Store profile</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Who you are on what Collabo prints: the “From” address and contact details on packing slips, and
          your logo on invoices, receipts and slips. Leave a field blank to fall back: the trading name and
          website fall back to your workspace’s, and the address to your default GSTIN’s registered address.
        </p>
      </div>

      <div id="store-logo" tabIndex={-1} className="scroll-mt-24 outline-none">
        <LogoSection
          logoUrl={saved.logoUrl}
          uploaded={!!saved.logoStorageKey}
          readOnly={!canManage}
          busy={uploadLogo.isPending ? "uploading" : removeLogo.isPending ? "removing" : null}
          onUpload={(file) => uploadLogo.mutate(file)}
          onRemove={() => removeLogo.mutate()}
        />
      </div>

      <section className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className={field.half ? "" : "sm:col-span-2"}>
              <label htmlFor={`store-${field.key}`} className="mb-1.5 block text-label">
                {field.label}
              </label>
              <Input
                id={`store-${field.key}`}
                value={draft[field.key]}
                onChange={(e) => set(field.key, e.target.value)}
                placeholder={field.placeholder}
                disabled={!canManage}
              />
            </div>
          ))}
        </div>

        {!org?.gstEnabled && !draft.address1 && (
          <p className="mt-4 text-caption text-warning-text">
            GST is off, so there is no GSTIN address to fall back to — fill the address in here or
            the slip’s From block will be blank.
          </p>
        )}
      </section>

      {canManage ? (
        <SaveBar
          dirty={dirty}
          saving={mutation.isPending}
          onDiscard={() => setForm({ base, draft: base })}
          what="the store profile"
        />
      ) : (
        <p className="text-caption text-muted-foreground">Only owners, admins and managers can change the store profile.</p>
      )}
    </form>
  );
}
