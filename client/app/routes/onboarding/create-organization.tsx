import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Building2, Globe, Upload, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { orgService } from "~/services/org.service";
import { useAuthStore } from "~/stores/auth.store";
import { orgKeys } from "~/hooks/use-org-queries";
import type { OrganizationMembership } from "~/types/api";
import { authService } from "~/services/auth.service";

/* ── Select field option lists ───────────────────────────── */

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

/* ── Form validation schema ─────────────────────────────── */
//
// Note: `currency` is intentionally NOT collected here. It gets auto-populated
// from the Shopify shop's currency when the user connects their Shopify store
// (see server/src/channel/shopify-oauth.service.ts). Users without Shopify
// keep the backend default ("USD") and can change it in Settings → General.

const createOrganizationSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  industry: z.string().optional(),
  website: z.string().url("Please enter a valid URL").optional().or(z.literal("")),
  logo: z.string().url("Please enter a valid logo URL").optional().or(z.literal("")),
  timezone: z.string().optional(),
});

type CreateOrganizationFormValues = z.infer<typeof createOrganizationSchema>;

export function meta() {
  return [{ title: "Create Organization | Collabo CRM" }];
}

/**
 * Onboarding step 2: organization creation form.
 * Collects org name, logo, industry, website, and timezone. Currency is
 * auto-populated from the Shopify shop on channel connect (not asked here).
 */
export default function CreateOrganizationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setCurrentOrg = useAuthStore((state) => state.setCurrentOrg);
  const setOrganizations = useAuthStore((state) => state.setOrganizations);
  const setTokens = useAuthStore((state) => state.setTokens);
  const existingOrgs = useAuthStore((state) => state.organizations);
  const pendingPlan = useAuthStore((state) => state.pendingPlan);
  const pendingBillingInterval = useAuthStore((state) => state.pendingBillingInterval);
  const clearPendingPlan = useAuthStore((state) => state.clearPendingPlan);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateOrganizationFormValues>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: "", industry: "", website: "", logo: "", timezone: "UTC" },
  });

  const logoValue = watch("logo");

  /* ── Mutation: create the organization ────────────────── */
  const createOrg = useMutation({
    mutationFn: (data: CreateOrganizationFormValues) => {
      return orgService.create({
        name: data.name,
        industry: data.industry || undefined,
        website: data.website || undefined,
        logo: data.logo || undefined,
        timezone: data.timezone || undefined,
        // currency is auto-synced from Shopify on channel connect; backend
        // default ("USD") covers users who haven't connected a store yet.
        billingPlan: pendingPlan ?? "BASIC",
        billingInterval: pendingBillingInterval ?? "MONTHLY",
      });
    },
    onSuccess: async (org) => {
      const switchData = await authService.switchOrg({ orgId: org.id });
      setTokens(switchData.accessToken, switchData.refreshToken);

      queryClient.invalidateQueries({ queryKey: orgKeys.list() });
      // Add the new org to the auth store so AuthGuard sees it
      const newMembership: OrganizationMembership = {
        id: crypto.randomUUID(),
        organizationId: org.id,
        role: "OWNER",
        isActive: true,
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          type: org.type || "ORGANIZATION",
          logo: org.logo || null,
          timezone: org.timezone || "UTC",
          currency: org.currency || "USD",
          industry: org.industry || null,
          website: org.website || null,
          billingPlan: org.billingPlan,
          billingInterval: org.billingInterval,
          onboardingStatus: "COMPLETED",
          createdAt: org.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      setOrganizations([...existingOrgs, newMembership]);
      setCurrentOrg(org.id);
      clearPendingPlan();

      toast.success(`${org.name} created!`);
      navigate(`/onboarding/invite-team?orgId=${org.id}`);
    },
    onError: (error) => {
      if (isAxiosError(error)) {
        toast.error(error.response?.data?.message || "Failed to create organization.");
      } else if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    },
  });

  /* ── Event handlers ──────────────────────────────────── */

  function onSubmit(data: CreateOrganizationFormValues) {
    createOrg.mutate(data);
  }

  function handleLogoUrlBlur() {
    const url = logoValue?.trim();
    if (url && /^https?:\/\/.+/.test(url)) {
      setLogoPreview(url);
    } else {
      setLogoPreview(null);
    }
  }

  function handleClearLogo() {
    setValue("logo", "");
    setLogoPreview(null);
  }

  const serverError =
    createOrg.error && isAxiosError(createOrg.error)
      ? createOrg.error.response?.data?.message
      : null;

  return (
    <div>


      {/* Heading */}
      <div className="mb-8 text-center pt-8">
        {/* <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <Building2 className="size-5 text-[#084734]" />
        </div> */}
        <h2 className="text-[38px] font-bold text-gray-900">Set up your workspace</h2>
        <p className="mt-1.5 text-[12px] text-gray-500">
          Configure your workspace details to personalize
          your commerce operations experience.
        </p>
      </div>

      {/* Form card */}
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/[0.06]">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">

          {/* Logo + Org name row */}
          <div className="flex gap-4">
            {/* Logo */}
            <div className="shrink-0">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Logo</label>
              <div className="relative flex size-[72px] items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 overflow-hidden transition hover:border-[#CEF17B]/60">
                {logoPreview ? (
                  <>
                    <img
                      src={logoPreview}
                      alt="Logo preview"
                      className="size-full object-cover"
                      onError={() => setLogoPreview(null)}
                    />
                    <button
                      type="button"
                      onClick={handleClearLogo}
                      className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-gray-900 text-white shadow-sm hover:bg-gray-700"
                    >
                      <X className="size-3" />
                    </button>
                  </>
                ) : (
                  <Upload className="size-5 text-gray-300" />
                )}
              </div>
            </div>

            {/* Name + Logo URL */}
            <div className="flex-1 space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                  Organization name <span className="text-red-500">*</span>
                </label>
                <input
                  id="name"
                  placeholder="Acme Store"
                  aria-invalid={!!errors.name}
                  {...register("name")}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
                />
                {errors.name && (
                  <p className="text-xs text-red-500">{errors.name.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="logo" className="block text-xs font-medium text-gray-500">
                  Logo URL <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  id="logo"
                  placeholder="https://example.com/logo.png"
                  {...register("logo")}
                  onBlur={handleLogoUrlBlur}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40"
                />
                {errors.logo && (
                  <p className="text-xs text-red-500">{errors.logo.message}</p>
                )}
              </div>
            </div>
          </div>

          {/* Industry + Website */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">
                Industry
              </label>
              <Select onValueChange={(selectedIndustry) => setValue("industry", selectedIndustry)}>
                <SelectTrigger className="w-full border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 shadow-sm focus:ring-[#CEF17B]/40">
                  <SelectValue placeholder="Select your industry" />
                </SelectTrigger>
                <SelectContent>
                  {INDUSTRIES.map((industry) => (
                    <SelectItem key={industry} value={industry}>{industry}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="website" className="block text-sm font-medium text-gray-700">
                Website
              </label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
                <input
                  id="website"
                  placeholder="https://yourstore.com"
                  {...register("website")}
                  className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40"
                />
              </div>
              {errors.website && (
                <p className="text-xs text-red-500">{errors.website.message}</p>
              )}
            </div>
          </div>

          {/* Timezone (currency is auto-synced from Shopify on channel connect) */}
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Timezone</label>
              <Select defaultValue="UTC" onValueChange={(selectedTimezone) => setValue("timezone", selectedTimezone)}>
                <SelectTrigger className="w-full border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 shadow-sm focus:ring-[#CEF17B]/40">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((timezone) => (
                    <SelectItem key={timezone.value} value={timezone.value}>{timezone.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Server error */}
          {serverError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm text-red-600">{serverError}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <Link
              to="/onboarding/account-type"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
            >
              <ArrowLeft className="size-4" /> Back
            </Link>

            <button
              type="submit"
              disabled={createOrg.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-[#CEF17B] px-5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createOrg.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Continue"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
