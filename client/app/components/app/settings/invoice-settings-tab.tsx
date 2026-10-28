import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Circle, Eye, ListChecks, Lock } from "lucide-react";

import { QueryErrorState } from "~/components/app/query-error-state";
import { SaveBar } from "~/components/app/save-bar";
import { SectionCard } from "~/components/app/section-card";
import { InvoicePreview } from "~/components/app/settings/invoice-preview";
import {
  BusinessSection,
  LogoFromStoreProfile,
  LookSection,
  PaymentsSection,
  ReceiptSection,
  ShowSection,
  SignatureSection,
  TermsSection,
} from "~/components/app/settings/invoice-settings-sections";
import { Button } from "~/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useGstins } from "~/hooks/use-gst-queries";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { usePosSetup } from "~/hooks/use-pos-queries";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import {
  useRemoveSignatureMutation,
  useSaveInvoiceSettingsMutation,
  useUploadSignatureMutation,
} from "~/hooks/use-settings-mutations";
import {
  defaultSample,
  draftErrors,
  panFromGstin,
  previewSamples,
  previewSettings,
  rebaseDraft,
  settingsPatch,
  toDraft,
  type InvoiceDraft,
} from "~/lib/invoice-settings";
import { UPI_ID } from "~/lib/pos-cart";
import type { InvoiceSample, InvoiceSettings } from "~/types/api";

/** Scrolls to a field and puts the cursor in it, for the setup checklist. */
function goTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  const field = target.matches("input, textarea, select, button")
    ? target
    : target.querySelector<HTMLElement>("input:not([type=file]), textarea, select, button");
  field?.focus({ preventScroll: true });
}

/**
 * Settings › Invoices & bills: how invoices, credit notes, bills and till
 * receipts look, with the server's own PDF of a sample beside the form.
 *
 * A form with one Save, like every settings form: the fields are local until
 * saved, and only the ones that changed are sent. The signature upload saves
 * at once; the logo is set on Store profile. Owners, admins and managers
 * change it (the server's ORG_MANAGERS); everyone else sees it read-only.
 */
export function InvoiceSettingsTab() {
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const settings = useOrganizationSettings();
  const { data: org } = useCurrentOrg();
  const { data: gstins = [] } = useGstins();
  // The UPI ID lives in the till's settings, which only managers may read.
  const pos = usePosSetup(undefined, canManage);
  const save = useSaveInvoiceSettingsMutation();
  const uploadSignature = useUploadSignatureMutation();
  const removeSignature = useRemoveSignatureMutation();
  // Wide enough for the preview beside the form. Below it the preview opens
  // on demand, so a hidden one is not fetched and drawn on every keystroke.
  const wide = useMediaQuery("(min-width: 1280px)");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [picked, setPicked] = useState<InvoiceSample | null>(null);

  // The form and the saved settings it started from. When the saved ones
  // change (an upload, a save, another manager), untouched fields follow.
  const saved = settings.data?.invoiceSettings;
  const [form, setForm] = useState<{ base: InvoiceSettings; draft: InvoiceDraft } | null>(null);
  useEffect(() => {
    if (!saved) return;
    setForm((f) => (f ? { base: saved, draft: rebaseDraft(f.base, saved, f.draft) } : { base: saved, draft: toDraft(saved) }));
  }, [saved]);

  const [upi, setUpi] = useState<{ base: string; draft: string } | null>(null);
  useEffect(() => {
    if (!pos.data) return;
    const next = pos.data.settings.upiId ?? "";
    setUpi((u) => (u ? { base: next, draft: u.draft === u.base ? next : u.draft } : { base: next, draft: next }));
  }, [pos.data]);

  const preview = useMemo(() => (form ? previewSettings(form.draft) : {}), [form]);
  const patch = form ? settingsPatch(form.base, form.draft) : {};
  const upiValue = upi?.draft.trim() ?? "";
  const upiChanged = !!upi && upiValue !== upi.base;
  const dirty = Object.keys(patch).length > 0 || upiChanged;

  if (settings.isError) {
    return <QueryErrorState resource="the invoice settings" onRetry={() => void settings.refetch()} />;
  }
  if (!form || !settings.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  const { draft, base } = form;
  const store = settings.data.storeProfileSettings;
  const readOnly = !canManage;
  const set = <K extends keyof InvoiceDraft>(key: K, value: InvoiceDraft[K]) =>
    setForm((f) => (f ? { ...f, draft: { ...f.draft, [key]: value } } : f));

  const errors = draftErrors(draft);
  const upiError = upiValue && !UPI_ID.test(upiValue) ? "A UPI ID looks like name@bank, with no spaces." : null;
  const blocked = Object.keys(errors).length > 0 || !!upiError;

  const gstEnabled = org?.gstEnabled ?? false;
  const composition = settings.data.taxSettings.composition;
  const samples = previewSamples({ gstEnabled, composition });
  const sample = picked && samples.includes(picked) ? picked : defaultSample({ gstEnabled, composition });
  const gstin = gstins.find((g) => g.isActive && g.isDefault) ?? gstins.find((g) => g.isActive);
  const pan = gstEnabled ? panFromGstin(gstin?.gstin) : null;

  const checklist: Array<{ label: string; done: boolean; target?: string; to?: string }> = [
    { label: "Upload your logo", done: !!store.logoStorageKey, to: "/settings/store-profile#store-logo" },
    { label: "Pick a brand colour", done: draft.brandColor !== null, target: "invoice-brand-hex" },
    { label: "Add your return policy", done: !!draft.returnPolicy.trim(), target: "invoice-return-policy" },
    ...(upi ? [{ label: "Add your UPI ID", done: !!upiValue, target: "invoice-upi" }] : []),
    { label: "Add your support WhatsApp", done: !!store.whatsappPhone.trim(), to: "/settings/store-profile#store-whatsappPhone" },
  ];
  const left = checklist.filter((item) => !item.done).length;

  function submit() {
    if (!dirty || blocked || save.isPending) return;
    // No reset afterwards: the saved values reach the form through the cache,
    // so anything typed while the request was out is kept.
    save.mutate({
      invoice: Object.keys(patch).length > 0 ? patch : null,
      upiId: upiChanged ? upiValue || null : undefined,
    });
  }

  function discard() {
    setForm({ base, draft: toDraft(base) });
    setUpi((u) => (u ? { ...u, draft: u.base } : u));
  }

  const previewPanel = (pagesClassName?: string) => (
    <InvoicePreview
      sample={sample}
      samples={samples}
      onSample={setPicked}
      settings={preview}
      canPreview={canManage}
      hasSeller={gstEnabled && !!gstin}
      pagesClassName={pagesClassName}
    />
  );
  const sectionProps = { draft, set, errors, readOnly };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-section max-md:hidden">Invoices & bills</h2>
        <p className="text-caption text-muted-foreground">
          How your invoices, credit notes and till receipts look. A document keeps the look it was issued with, so changes
          here apply to new ones.
        </p>
      </div>

      {readOnly && (
        <p className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-caption text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          Only owners, admins and managers can change these settings.
        </p>
      )}

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start xl:gap-6">
        <form
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {!readOnly && left > 0 && (
            <SectionCard
              title="Finish setting up"
              icon={<ListChecks className="size-4 text-muted-foreground" />}
              description={`${checklist.length - left} of ${checklist.length} done. These make invoices look like your brand.`}
            >
              <ul className="grid gap-1 p-3 sm:grid-cols-2">
                {checklist.map((item) => {
                  const Icon = item.done ? CheckCircle2 : Circle;
                  const content = (
                    <>
                      <Icon className={item.done ? "size-4 shrink-0 text-success" : "size-4 shrink-0 text-muted-foreground"} />
                      <span className={item.done ? "text-muted-foreground line-through" : "text-foreground"}>{item.label}</span>
                    </>
                  );
                  const rowClass = "flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-body";
                  return (
                    <li key={item.label}>
                      {item.done ? (
                        <span className={rowClass}>{content}</span>
                      ) : item.to ? (
                        <Link to={item.to} className={`${rowClass} hover:bg-muted`}>
                          {content}
                        </Link>
                      ) : (
                        <a
                          href={`#${item.target}`}
                          onClick={(e) => {
                            e.preventDefault();
                            goTo(item.target!);
                          }}
                          className={`${rowClass} hover:bg-muted`}
                        >
                          {content}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          )}

          <LookSection {...sectionProps} />
          <LogoFromStoreProfile logoUrl={store.logoUrl} uploaded={!!store.logoStorageKey} />
          <BusinessSection {...sectionProps} pan={pan} />
          <TermsSection {...sectionProps} />
          <SignatureSection
            {...sectionProps}
            signatureUrl={base.signature?.url ?? null}
            busy={uploadSignature.isPending ? "uploading" : removeSignature.isPending ? "removing" : null}
            onUpload={(file) => uploadSignature.mutate(file)}
            onRemove={() => removeSignature.mutate()}
          />
          <ShowSection {...sectionProps} />
          <PaymentsSection
            {...sectionProps}
            upiId={upi ? upi.draft : null}
            upiError={upiError}
            onUpiId={(value) => setUpi((u) => (u ? { ...u, draft: value } : u))}
          />
          <ReceiptSection {...sectionProps} />

          {/* Pinned while there is something to save, or while the Preview
              button is the only way to the preview. */}
          {canManage && (
            <SaveBar dirty={dirty} saving={save.isPending} invalid={blocked} onDiscard={discard} pinned={!wide} what="invoices and bills">
              {!wide && (
                <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)} className="max-md:flex-1">
                  <Eye />
                  Preview
                </Button>
              )}
            </SaveBar>
          )}
        </form>

        {/* top-24 keeps it below the 72 px app bar, which is sticky too. */}
        {wide && (
          <aside className="sticky top-24" aria-label="Preview">
            <SectionCard title="Preview" description="A sample, as your customers get it.">
              <div className="p-4">{previewPanel("max-h-[calc(100dvh-19rem)] overflow-y-auto")}</div>
            </SectionCard>
          </aside>
        )}
      </div>

      {!wide && (
        <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
          <SheetContent className="w-full max-w-none sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>Preview</SheetTitle>
              <SheetDescription>A sample, as your customers get it. Unsaved changes included.</SheetDescription>
            </SheetHeader>
            <SheetBody className="px-4">{previewOpen && previewPanel()}</SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
