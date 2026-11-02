import { useState } from "react";
import {
  Building2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Plus,
  Sparkles,
  Globe,
  Briefcase,
  Image as ImageIcon,
  Clock,
  Check,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "~/components/ui/sheet";
import {
  useUpgradeToOrganizationMutation,
  useCreateOrganizationInSettingsMutation,
} from "~/hooks/use-org-mutations";
import { cn } from "~/lib/utils";
import type { OrgResponse } from "~/types/api";

const INDUSTRIES = [
  "Retail", "E-commerce", "Fashion", "Electronics", "Food & Beverage",
  "Health & Beauty", "Home & Garden", "Sports & Outdoors", "Technology",
  "Education", "Finance", "Healthcare", "Real Estate", "Travel & Hospitality", "Other",
];

const TIMEZONES = [
  { label: "UTC (Coordinated Universal Time)", value: "UTC" },
  { label: "America/New_York (EST/EDT)", value: "America/New_York" },
  { label: "America/Chicago (CST/CDT)", value: "America/Chicago" },
  { label: "America/Los_Angeles (PST/PDT)", value: "America/Los_Angeles" },
  { label: "Europe/London (GMT/BST)", value: "Europe/London" },
  { label: "Europe/Paris (CET/CEST)", value: "Europe/Paris" },
  { label: "Asia/Kolkata (IST)", value: "Asia/Kolkata" },
  { label: "Asia/Tokyo (JST)", value: "Asia/Tokyo" },
  { label: "Asia/Dubai (GST)", value: "Asia/Dubai" },
  { label: "Australia/Sydney (AEST/AEDT)", value: "Australia/Sydney" },
];

type Step = "choice" | "form";
type Path = "upgrade" | "create";

/**
 * Right-side sheet for setting up a team organization from Settings. Two
 * paths share the same form step:
 *
 *   - "upgrade" → flip the existing PERSONAL workspace to ORGANIZATION
 *     in place. Data, billing, and members are preserved. Uses
 *     `POST /organizations/:id/upgrade-to-organization`.
 *   - "create"  → create a brand-new ORGANIZATION alongside the personal
 *     workspace, and switch into it. Uses `POST /organizations` + auth
 *     /switch-org. Bypasses the /onboarding flow (which bounces
 *     already-onboarded users via OnboardingGuard) so the user never
 *     leaves Settings.
 *
 * Built on `Sheet` so the page stays partially visible behind a soft
 * backdrop — feels less abrupt than a centered modal.
 */
export function UpgradeOrganizationDialog({
  org,
  onClose,
  initialPath,
}: {
  org: OrgResponse;
  onClose: () => void;
  /**
   * If provided, the sheet skips the "choice" step and opens straight on the
   * form for the given path. Used for org users who only have the "create
   * new" option (no upgrade to do — they're already an organization).
   */
  initialPath?: Path;
}) {
  const upgradeMutation = useUpgradeToOrganizationMutation(org.id);
  const createMutation = useCreateOrganizationInSettingsMutation();
  const [step, setStep] = useState<Step>(initialPath ? "form" : "choice");
  const [path, setPath] = useState<Path>(initialPath ?? "upgrade");

  const isPending = upgradeMutation.isPending || createMutation.isPending;
  const isCreatePath = path === "create";
  const choiceStepAvailable = !initialPath;

  // Form state. Pre-fill from the current workspace only when upgrading;
  // creating a new org starts empty so the user doesn't carry over the
  // "Personal" workspace's name by accident.
  const [name, setName] = useState(
    initialPath === "upgrade" ? (org.name ?? "") : "",
  );
  const [logo, setLogo] = useState(
    initialPath === "upgrade" ? (org.logo ?? "") : "",
  );
  const [industry, setIndustry] = useState(
    initialPath === "upgrade" ? (org.industry ?? "") : "",
  );
  const [website, setWebsite] = useState(
    initialPath === "upgrade" ? (org.website ?? "") : "",
  );
  const [timezone, setTimezone] = useState(
    initialPath === "upgrade" ? (org.timezone ?? "UTC") : "UTC",
  );
  const [logoBroken, setLogoBroken] = useState(false);

  function enterFormStep(nextPath: Path) {
    setPath(nextPath);
    setStep("form");
    if (nextPath === "upgrade") {
      setName(org.name ?? "");
      setLogo(org.logo ?? "");
      setIndustry(org.industry ?? "");
      setWebsite(org.website ?? "");
      setTimezone(org.timezone ?? "UTC");
    } else {
      setName("");
      setLogo("");
      setIndustry("");
      setWebsite("");
      setTimezone("UTC");
    }
    setLogoBroken(false);
  }

  function handleSubmit() {
    if (name.trim().length < 2) return;
    const payload = {
      name: name.trim(),
      logo: logo.trim() || undefined,
      industry: industry || undefined,
      website: website.trim() || undefined,
      timezone: timezone || undefined,
    };
    if (isCreatePath) {
      createMutation.mutate(
        {
          ...payload,
          // Defaults match the onboarding fallback in account-type.tsx:
          // pricing is hidden, server early-returns from
          // applyPendingSubscriptionToOrg when no pending subscription
          // exists, so these values just stamp the new org's billing
          // metadata.
          billingPlan: "BASIC",
          billingInterval: "MONTHLY",
        },
        { onSuccess: () => onClose() },
      );
    } else {
      upgradeMutation.mutate(payload, { onSuccess: () => onClose() });
    }
  }

  function handleSheetOpenChange(open: boolean) {
    if (!open && !isPending) onClose();
  }

  return (
    <Sheet open onOpenChange={handleSheetOpenChange}>
      <SheetContent className="p-0">
        <SheetHeader className="bg-gradient-to-br from-[#CEF17B]/30 via-white to-white dark:from-[#084734]/30 dark:via-gray-900 dark:to-gray-900">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-[#CEF17B] text-[#084734]">
              <Sparkles className="size-3.5" />
            </div>
            <SheetTitle>
              {!choiceStepAvailable && isCreatePath
                ? "Create new organization"
                : "Set up an organization"}
            </SheetTitle>
          </div>
          <SheetDescription>
            {step === "choice"
              ? "Choose how you want to proceed."
              : isCreatePath
                ? "Tell us about your new organization."
                : "A few details to get your organization ready."}
          </SheetDescription>

          {/* The step indicator is only meaningful when there's a previous
              step to point back to. When we open straight on the form (no
              choice step), the indicator would just be a single filled bar
              — that's noise, so we hide it. */}
          {step === "form" && choiceStepAvailable && <StepIndicator step={2} total={2} />}
        </SheetHeader>

        {step === "choice" ? (
          <SheetBody>
            <div className="space-y-3">
              <ChoiceCard
                icon={<RefreshCw className="size-4" />}
                title="Upgrade this workspace"
                tagline="Recommended"
                body="Convert your personal workspace into a team organization. All your data — products, orders, customers — stays put. Your current plan and billing carry over."
                bullets={[
                  "Same data, same workspace",
                  "Keeps your active subscription",
                  "Type flips to Organization",
                ]}
                cta="Upgrade in place"
                onClick={() => enterFormStep("upgrade")}
              />

              <ChoiceCard
                icon={<Plus className="size-4" />}
                title="Create a new organization"
                body="Keep your personal workspace and create a separate organization alongside it. We'll switch you over to the new one right away — you can switch back from the org switcher anytime."
                bullets={[
                  "Personal workspace stays as-is",
                  "Switch between workspaces anytime",
                  "Invite teammates after setup",
                ]}
                cta="Set up new organization"
                onClick={() => enterFormStep("create")}
              />
            </div>
          </SheetBody>
        ) : (
          <SheetBody>
            <div className="space-y-5">
              <FormField
                label="Organization name"
                hint="The name shown across your CRM."
                required
                icon={<Building2 className="size-3.5" />}
              >
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Co."
                  maxLength={100}
                  className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </FormField>

              <FormField
                label="Logo"
                hint="Optional — a square image (URL) works best."
                icon={<ImageIcon className="size-3.5" />}
              >
                <div className="flex items-start gap-3">
                  <input
                    value={logo}
                    onChange={(e) => {
                      setLogo(e.target.value);
                      setLogoBroken(false);
                    }}
                    placeholder="https://"
                    className="h-10 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                  />
                  <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/40">
                    {logo && !logoBroken ? (
                      <img
                        src={logo}
                        alt="Logo preview"
                        className="size-full object-cover"
                        onError={() => setLogoBroken(true)}
                      />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground" />
                    )}
                  </div>
                </div>
              </FormField>

              <FormField
                label="Industry"
                hint="Optional — used for tailored suggestions."
                icon={<Briefcase className="size-3.5" />}
              >
                <Select value={industry || undefined} onValueChange={setIndustry}>
                  <SelectTrigger className="h-10 w-full border-input bg-transparent">
                    <SelectValue placeholder="Select industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDUSTRIES.map((i) => (
                      <SelectItem key={i} value={i}>
                        {i}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Website"
                hint="Optional."
                icon={<Globe className="size-3.5" />}
              >
                <input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://yourstore.com"
                  className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </FormField>

              <FormField label="Timezone" icon={<Clock className="size-3.5" />}>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger className="h-10 w-full border-input bg-transparent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>
                        {tz.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          </SheetBody>
        )}

        <SheetFooter>
          {step === "form" ? (
            <>
              <button
                onClick={() => (choiceStepAvailable ? setStep("choice") : onClose())}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                <ArrowLeft className="size-3.5" />
                {choiceStepAvailable ? "Back" : "Cancel"}
              </button>
              <div className="flex-1" />
              <button
                onClick={handleSubmit}
                disabled={isPending || name.trim().length < 2}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-[#084734] hover:bg-[#BADE6F] disabled:opacity-50"
              >
                {isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isCreatePath ? (
                  <Plus className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {isCreatePath ? "Create organization" : "Upgrade workspace"}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="ml-auto rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Not now
            </button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ─── Local UI helpers ─────────────────────────────────────────────────── */

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="mt-3 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors",
            n <= step ? "bg-[#CEF17B]" : "bg-gray-200 dark:bg-gray-700",
          )}
        />
      ))}
    </div>
  );
}

function ChoiceCard({
  icon,
  title,
  tagline,
  body,
  bullets,
  cta,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  tagline?: string;
  body: string;
  bullets: string[];
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group block w-full rounded-xl border bg-white dark:bg-gray-900 p-4 text-left transition-all hover:border-[#CEF17B] hover:shadow-md focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#CEF17B]/30 text-[#084734]">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </p>
            {tagline && (
              <span className="inline-flex items-center rounded-full bg-[#CEF17B]/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#084734]">
                {tagline}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {body}
          </p>
          <ul className="mt-2.5 space-y-1">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-1.5 text-[11px] text-gray-700 dark:text-gray-300">
                <Check className="mt-0.5 size-3 shrink-0 text-[#084734]" />
                {b}
              </li>
            ))}
          </ul>
          <p className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-[#084734] group-hover:underline">
            {cta}
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </p>
        </div>
      </div>
    </button>
  );
}

function FormField({
  label,
  hint,
  required,
  icon,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[11px] font-medium text-gray-700 dark:text-gray-300">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
