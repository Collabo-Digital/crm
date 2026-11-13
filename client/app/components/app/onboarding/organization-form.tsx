import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { StepFrame } from "~/components/app/onboarding/step-frame";
import { PhoneInput } from "~/components/app/phone-input";
import { ImageUpload } from "~/components/app/settings/image-upload";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  OrganizationSaveError,
  recordOnboardingStep,
  useOnboardingWizard,
  useSaveOrganizationStep,
  type OrganizationSavePart,
} from "~/hooks/use-onboarding";
import { useRemoveLogoMutation, useUploadLogoMutation } from "~/hooks/use-settings-mutations";
import { serverMessage } from "~/lib/handle-mutation-error";
import { updateOnboardingDraft } from "~/lib/onboarding-draft";
import {
  gstinState,
  ORGANIZATION_FIELD_ORDER,
  validateOrganizationForm,
  type OrganizationField,
  type OrganizationFormValues,
} from "~/lib/onboarding-organization";
import { onboardingStepPath } from "~/lib/onboarding-steps";
import { COUNTRIES, detectTimezone, INDIA, INDUSTRIES, timezoneLabel, timezoneOptions } from "~/lib/org-options";
import { GST_STATES } from "~/lib/pos-cart";
import { getLandingPath } from "~/lib/sections";
import { SessionChangedError } from "~/lib/session-stamp";
import { signOut } from "~/lib/sign-out";

const INDIAN_STATES = GST_STATES.map((state) => state.name).sort((a, b) => a.localeCompare(b));

/** Typing pauses this long before the draft is written to the browser. */
const DRAFT_SAVE_DELAY = 400;

const fieldId = (field: OrganizationField) => `org-${field}`;

/** A value already on file stays selectable even when the list no longer offers it. */
const withCurrent = (options: readonly string[], current: string) =>
  current && !options.includes(current) ? [current, ...options] : options;

const SAVED_SO_FAR: Record<OrganizationSavePart, string> = {
  workspace: "We couldn't create your workspace.",
  details: "Your workspace is created, but its name and industry didn't save.",
  contact: "Your workspace is saved, but the contact details and address didn't save.",
  gst: "Your workspace is saved, but the GSTIN didn't save.",
  progress: "Your details are saved, but we couldn't move on to the next step.",
};

function saveErrorMessage(error: unknown): string {
  if (error instanceof SessionChangedError) return error.message;
  if (!(error instanceof OrganizationSaveError)) return "Something went wrong. Nothing you typed is lost: try again.";
  return [SAVED_SO_FAR[error.part], serverMessage(error.cause, ""), "Nothing you typed is lost: try again."]
    .filter(Boolean)
    .join(" ");
}

function Field({
  field,
  label,
  required = false,
  note,
  hint,
  error,
  className,
  children,
}: {
  field: OrganizationField;
  label: string;
  required?: boolean;
  /** Greyed text after the label: "(optional)". */
  note?: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={fieldId(field)} className="mb-1.5 block text-label">
        {label}
        {required && (
          <span className="text-danger-text" aria-hidden>
            {" "}
            *
          </span>
        )}
        {note && <span className="text-muted-foreground"> {note}</span>}
      </label>
      {children}
      {error ? (
        <p id={`${fieldId(field)}-error`} className="mt-1.5 flex items-start gap-1.5 text-caption text-danger-text">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-caption text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-section">{title}</h2>
          {description && <p className="mt-1 text-body text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

/**
 * Setup step 2: the business's name, contact, address and GST registration.
 *
 * Saving it is what creates the workspace. Until then nothing reaches the
 * server: the form autosaves to the browser draft, so the owner can leave
 * with half of it filled in. Once the step has been saved the server holds
 * it, and the form edits that saved copy like any settings page.
 */
export function OrganizationForm({
  initial,
  resumed,
  savedLogoUrl,
}: {
  initial: OrganizationFormValues;
  /** The draft already had answers when the page opened: show what is still missing straight away. */
  resumed: boolean;
  /** The logo on the store profile, once the workspace has one. */
  savedLogoUrl: string;
}) {
  const navigate = useNavigate();
  const { userId, orgId, audience, completedSteps } = useOnboardingWizard();
  const stepDone = completedSteps.has("organization");
  const saveStep = useSaveOrganizationStep();
  const uploadLogo = useUploadLogoMutation();
  const removeLogo = useRemoveLogoMutation();

  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<OrganizationField>>(new Set());
  const [attempted, setAttempted] = useState(resumed);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A logo picked before the workspace exists waits here and goes up with the save.
  const [pendingLogo, setPendingLogo] = useState<{ file: File; url: string } | null>(null);
  const [pickingTimezone, setPickingTimezone] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const errors = validateOrganizationForm(values);
  const errorCount = Object.keys(errors).length;
  const firstError = ORGANIZATION_FIELD_ORDER.find((field) => errors[field]);
  const shownError = (field: OrganizationField) => (attempted || touched.has(field) ? errors[field] : undefined);
  const dirty = values !== initial || pendingLogo !== null;
  const busy = saveStep.isPending || leaving;
  const inIndia = values.country === INDIA;
  const detectedTimezone = useMemo(detectTimezone, []);
  const timezones = useMemo(
    () => (pickingTimezone ? withCurrent(timezoneOptions(), values.timezone) : []),
    [pickingTimezone, values.timezone],
  );
  const registeredState = gstinState(values.gstin);

  const set = (patch: Partial<OrganizationFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const touch = (field: OrganizationField) =>
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));

  /** The props every text field shares. */
  const text = (field: Exclude<OrganizationField, "gstRegistered">) => ({
    id: fieldId(field),
    value: values[field],
    onBlur: () => touch(field),
    "aria-invalid": shownError(field) ? true : undefined,
    "aria-describedby": shownError(field) ? `${fieldId(field)}-error` : undefined,
  });

  // Until the step is saved, the browser draft is the only copy.
  useEffect(() => {
    if (stepDone || values === initial) return;
    const timer = setTimeout(
      () => updateOnboardingDraft(userId, { organization: values, step: "organization" }),
      DRAFT_SAVE_DELAY,
    );
    return () => clearTimeout(timer);
  }, [values, initial, stepDone, userId]);

  useEffect(() => {
    if (!pendingLogo) return;
    return () => URL.revokeObjectURL(pendingLogo.url);
  }, [pendingLogo]);

  function focusFirstError() {
    if (firstError) document.getElementById(fieldId(firstError))?.focus();
  }

  async function save(): Promise<boolean> {
    setSaveError(null);
    try {
      const { logoFailed } = await saveStep.mutateAsync({
        values,
        audience,
        logo: pendingLogo?.file ?? null,
        advance: !stepDone,
      });
      setPendingLogo(null);
      if (logoFailed) {
        toast.warning("Your details are saved, but the logo didn't upload. Add it later in Settings › Store profile.");
      }
      return true;
    } catch (error) {
      setSaveError(saveErrorMessage(error));
      return false;
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (errorCount > 0) {
      focusFirstError();
      return;
    }
    if (await save()) navigate(onboardingStepPath("business"));
  }

  /** To the app, remembering to reopen the wizard on this step. */
  async function leave(workspaceId: string) {
    setLeaving(true);
    await recordOnboardingStep(workspaceId, "organization");
    navigate(getLandingPath());
  }

  async function handleExit() {
    // Don't wait for the typing pause: what is on screen is what must be kept.
    if (!stepDone) updateOnboardingDraft(userId, { organization: values, step: "organization" });

    if (!orgId) {
      // No workspace yet, so there is nowhere in the app to go: the draft waits for the next sign-in.
      setLeaving(true);
      await signOut();
      navigate("/auth/login");
      return;
    }
    if (!stepDone || !dirty) return leave(orgId);
    // An edit to a saved step is saved whole or not at all.
    if (errorCount > 0) {
      setLeaveDialogOpen(true);
      return;
    }
    if (await save()) await leave(orgId);
  }

  function handleLogoPicked(file: File) {
    if (orgId) uploadLogo.mutate(file, { onSuccess: () => setPendingLogo(null) });
    else setPendingLogo({ file, url: URL.createObjectURL(file) });
  }

  function handleLogoRemoved() {
    if (pendingLogo) setPendingLogo(null);
    else removeLogo.mutate();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <StepFrame
        title="Set up your organization"
        description={
          <>
            These details appear on invoices, package slips and messages to customers. Fields marked{" "}
            <span className="text-danger-text">*</span> are required.
          </>
        }
        status={stepDone ? (dirty ? undefined : "Progress saved") : "Draft saved"}
        exit={
          <Button type="button" variant="outline" disabled={busy} onClick={() => void handleExit()}>
            {leaving && <Loader2 className="animate-spin" aria-hidden />}
            {orgId ? "Save & exit" : "Save & sign out"}
          </Button>
        }
        footer={
          <>
            <Button variant="ghost" asChild>
              <Link to={onboardingStepPath("welcome")}>
                <ArrowLeft aria-hidden />
                Previous
              </Link>
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-4">
              {attempted && errorCount > 0 && (
                <p className="text-body text-danger-text">
                  Fix {errorCount} {errorCount === 1 ? "field" : "fields"} to continue
                </p>
              )}
              <Button type="submit" size="lg" className="h-11 px-5" disabled={busy}>
                {saveStep.isPending && <Loader2 className="animate-spin" aria-hidden />}
                Save & continue
                {!saveStep.isPending && <ArrowRight aria-hidden />}
              </Button>
            </div>
          </>
        }
      >
        {resumed && errorCount > 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-warning-subtle px-4 py-3 text-body text-warning-text">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Your draft is saved. {errorCount} {errorCount === 1 ? "field is" : "fields are"} still needed before you can
            continue.
          </p>
        )}

        <Section title="Business basics">
          <ImageUpload
            id="org-logo"
            noun="logo"
            imageUrl={pendingLogo?.url ?? (savedLogoUrl || null)}
            maxBytes={1024 * 1024}
            minWidth={300}
            hint="Logo is optional: PNG or JPG, at least 300 px wide, up to 1 MB."
            readOnly={false}
            busy={uploadLogo.isPending ? "uploading" : removeLogo.isPending ? "removing" : null}
            onUpload={handleLogoPicked}
            onRemove={handleLogoRemoved}
          />

          <Field field="name" label="Business name" required error={shownError("name")}>
            <Input
              {...text("name")}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Acme Store"
              autoComplete="organization"
              maxLength={100}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field field="industry" label="Industry" required error={shownError("industry")}>
              <Select
                value={values.industry}
                onValueChange={(industry) => set({ industry })}
                onOpenChange={(open) => !open && touch("industry")}
              >
                <SelectTrigger id={fieldId("industry")} className="w-full" aria-invalid={shownError("industry") ? true : undefined}>
                  <SelectValue placeholder="Select your industry" />
                </SelectTrigger>
                <SelectContent>
                  {withCurrent(INDUSTRIES, values.industry).map((industry) => (
                    <SelectItem key={industry} value={industry}>
                      {industry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field field="website" label="Website" note="(optional)" error={shownError("website")}>
              <Input
                {...text("website")}
                onChange={(event) => set({ website: event.target.value })}
                placeholder="acmestore.in"
                inputMode="url"
                autoComplete="url"
              />
            </Field>
          </div>
        </Section>

        <Section title="Business contact" description="Where customers and couriers can reach you.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field field="email" label="Business email" required error={shownError("email")}>
              <Input
                {...text("email")}
                onChange={(event) => set({ email: event.target.value })}
                type="email"
                placeholder="hello@acmestore.in"
                autoComplete="email"
              />
            </Field>

            <Field field="phone" label="Phone" required error={shownError("phone")}>
              <PhoneInput
                id={fieldId("phone")}
                label="Phone"
                hideLabel
                value={values.phone || undefined}
                onChange={(phone) => set({ phone: phone ?? "" })}
                onBlur={() => touch("phone")}
                error={shownError("phone") ?? null}
              />
            </Field>
          </div>
        </Section>

        <Section title="Location">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field field="country" label="Country" required error={shownError("country")}>
              <Select
                value={values.country}
                onValueChange={(country) =>
                  // States and GST are India's; neither carries over to another country.
                  set({ country, state: "", ...(country !== INDIA && { gstRegistered: false }) })
                }
                onOpenChange={(open) => !open && touch("country")}
              >
                <SelectTrigger id={fieldId("country")} className="w-full" aria-invalid={shownError("country") ? true : undefined}>
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {withCurrent(COUNTRIES, values.country).map((country) => (
                    <SelectItem key={country} value={country}>
                      {country}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field field="state" label={inIndia ? "State" : "State or region"} required error={shownError("state")}>
              {inIndia ? (
                <Select
                  value={values.state}
                  onValueChange={(state) => set({ state })}
                  onOpenChange={(open) => !open && touch("state")}
                >
                  <SelectTrigger id={fieldId("state")} className="w-full" aria-invalid={shownError("state") ? true : undefined}>
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent>
                    {withCurrent(INDIAN_STATES, values.state).map((state) => (
                      <SelectItem key={state} value={state}>
                        {state}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  {...text("state")}
                  onChange={(event) => set({ state: event.target.value })}
                  autoComplete="address-level1"
                  maxLength={100}
                />
              )}
            </Field>

            <Field field="city" label="City" required error={shownError("city")}>
              <Input
                {...text("city")}
                onChange={(event) => set({ city: event.target.value })}
                placeholder="Mumbai"
                autoComplete="address-level2"
                maxLength={100}
              />
            </Field>

            <Field field="pin" label={inIndia ? "PIN code" : "Postal code"} error={shownError("pin")}>
              <Input
                {...text("pin")}
                onChange={(event) => set({ pin: event.target.value })}
                placeholder={inIndia ? "400013" : undefined}
                inputMode={inIndia ? "numeric" : undefined}
                autoComplete="postal-code"
                maxLength={20}
              />
            </Field>
          </div>

          <Field field="street" label="Street address" note="(for invoices and package slips)" error={shownError("street")}>
            <Input
              {...text("street")}
              onChange={(event) => set({ street: event.target.value })}
              placeholder="Building, street, area"
              autoComplete="street-address"
              maxLength={200}
            />
          </Field>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-muted-foreground">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>
                Timezone: {timezoneLabel(values.timezone)}
                {values.timezone === detectedTimezone && ", detected from your browser"}
              </span>
              {!pickingTimezone && (
                <Button type="button" variant="link" size="sm" onClick={() => setPickingTimezone(true)}>
                  Change
                </Button>
              )}
            </div>
            {pickingTimezone && (
              <Select value={values.timezone} onValueChange={(timezone) => set({ timezone })}>
                <SelectTrigger aria-label="Timezone" className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </Section>

        {inIndia && (
          <Section
            title="GST"
            description="Turn on to issue GST invoices. You can add more GSTINs later in Settings."
            action={
              <label htmlFor={fieldId("gstRegistered")} className="flex items-center gap-3 text-label">
                I'm GST registered
                <Switch
                  id={fieldId("gstRegistered")}
                  checked={values.gstRegistered}
                  onCheckedChange={(gstRegistered) => set({ gstRegistered })}
                />
              </label>
            }
          >
            {values.gstRegistered && (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  field="gstin"
                  label="GSTIN"
                  required
                  error={shownError("gstin")}
                  hint={
                    !errors.gstin &&
                    registeredState && (
                      <span className="flex items-center gap-1.5 text-success-text">
                        <Check className="size-3.5 shrink-0" aria-hidden />
                        Valid format · State {registeredState.code}, {registeredState.name}
                      </span>
                    )
                  }
                >
                  <Input
                    {...text("gstin")}
                    onChange={(event) => set({ gstin: event.target.value.toUpperCase().replace(/\s/g, "") })}
                    placeholder="27AABCU9603R1ZM"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={15}
                  />
                </Field>

                <Field
                  field="legalName"
                  label="Legal name"
                  required
                  error={shownError("legalName")}
                  hint="As it appears on your GST certificate"
                >
                  <Input
                    {...text("legalName")}
                    onChange={(event) => set({ legalName: event.target.value })}
                    placeholder="Acme Retail Private Limited"
                    autoComplete="off"
                    maxLength={200}
                  />
                </Field>
              </div>
            )}
          </Section>
        )}

        {saveError && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-subtle px-4 py-3 text-body text-danger-text">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {saveError}
          </p>
        )}
      </StepFrame>

      <Dialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>These changes can't be saved yet</DialogTitle>
            <DialogDescription>
              {firstError && errors[firstError]} Your earlier details are still saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLeaveDialogOpen(false);
                if (orgId) void leave(orgId);
              }}
            >
              Leave without saving
            </Button>
            <Button
              type="button"
              onClick={() => {
                setLeaveDialogOpen(false);
                setAttempted(true);
                // After the dialog has handed focus back.
                requestAnimationFrame(focusFirstError);
              }}
            >
              Fix it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
