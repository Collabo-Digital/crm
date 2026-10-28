import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import {
  Building2, Lock, Bell, Palette, Users, Shield, Smartphone,
  Check, ChevronRight, AlertTriangle, Loader2, Plus, X, Mail, Trash2,
  Sun, Moon, Monitor, Receipt, Star, MapPin, Package, ShoppingBag, Layers, MessageSquare,
  Pencil, Store, ArrowLeft, ReceiptText,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { ModalFrame, ModalTitle } from "~/components/app/order-dialog-primitives";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import { useThemeStore } from "~/stores/theme.store";
import { useCurrentOrg, useOrgMembers, useOrgInvites } from "~/hooks/use-org-queries";
import {
  useUpdateOrganizationMutation,
  useDeleteOrganizationMutation,
  useUpdateMemberRoleMutation,
  useRemoveMemberMutation,
  useSendInviteMutation,
  useRevokeInviteMutation,
  useUpdateMemberPermissionsMutation,
} from "~/hooks/use-org-mutations";
import { userService } from "~/services/user.service";
import { apiClient } from "~/lib/api-client";
import { useGstins, useIndianStates, useStateTaxRates, useProductTypeTaxRates, useCollections, useCollectionOverrides } from "~/hooks/use-gst-queries";
import {
  useCreateGstinMutation, useUpdateGstinMutation, useDeleteGstinMutation,
  useCreateStateTaxRateMutation, useDeleteStateTaxRateMutation, useUpdateStateTaxRateMutation,
  useCreateProductTypeTaxRateMutation, useDeleteProductTypeTaxRateMutation,
  useCreateCollectionOverrideMutation, useDeleteCollectionOverrideMutation,
} from "~/hooks/use-gst-mutations";
import { useProductTypes } from "~/hooks/use-product-queries";
import { useRecomputeLoyaltyMutation } from "~/hooks/use-loyalty-mutations";
import { BillingIcon, BillingTab } from "~/components/app/settings/billing-tab";
import {
  ProductSettingsTab,
  OrderSettingsTab,
} from "~/components/app/settings/sync-settings-tab";
import { InfluencersSection } from "~/components/app/influencers/influencers-section";
import { useCurrentRole } from "~/hooks/use-current-role";
import { ChannelSettingsTab } from "~/components/app/settings/channel-settings-tab";
import { InboxSettingsTab } from "~/components/app/settings/inbox-settings-tab";
import { DevelopersIcon, DevelopersTab } from "~/components/app/settings/developers-tab";
import { useSectionAccess } from "~/hooks/use-section-access";
import { StoreProfileTab } from "~/components/app/settings/store-profile-tab";
import { UpgradeOrganizationDialog } from "~/components/app/settings/upgrade-organization-dialog";
import {
  CapabilityPicker,
  DEFAULT_CAPABILITIES,
  MANAGED_CAPABILITY_KEYS,
  SectionAccessPicker,
  accessGrants,
} from "~/components/app/settings/section-access-picker";
import { AVAILABLE_SECTIONS, isSectionScopedRole, sectionKey, sectionsInGrants, type SectionId } from "~/lib/sections";
import { formatCurrency } from "~/lib/utils";
import type { UserRole, OrgMember, OrganizationGstin, CreateGstinRequest, StateTaxRate, ProductTypeTaxRate, CollectionTaxOverride, ShopifyCollection, LoyaltyMetric, OrgResponse, Warehouse } from "~/types/api";
import { readAddress } from "~/lib/address";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { LocationKindBadge } from "~/components/app/inventory/location-kind-badge";
import { GstReturnSettings } from "~/components/app/settings/gst-return-settings";
import { CatalogPricesSetting } from "~/components/app/settings/catalog-prices-setting";
import { InvoiceSeriesSetting } from "~/components/app/settings/invoice-series-setting";
import { InvoiceSettingsTab } from "~/components/app/settings/invoice-settings-tab";
import { TaxSchemeSetting } from "~/components/app/settings/tax-scheme-setting";
import { platformOffered } from "~/lib/channel-providers";
import { roleLabel } from "~/lib/labels";
import { pageTitle } from "~/lib/page-title";

export function meta({ params }: { params: { tab?: string } }) {
  // Each tab gets its own title, so tabs and screen readers can tell them apart.
  const tab = TABS.find((t) => t.id === params.tab);
  return [{ title: pageTitle(tab?.label, "Settings") }];
}

// ── Sidebar tabs ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "general", label: "General", icon: Building2 },
  { id: "store-profile", label: "Store Profile", icon: Store },
  { id: "products", label: "Products", icon: Package },
  { id: "orders", label: "Orders", icon: ShoppingBag },
  { id: "channels", label: "Channels", icon: Layers },
  { id: "inbox", label: "Inbox", icon: MessageSquare },
  { id: "tax-gst", label: "Tax & GST", icon: Receipt },
  { id: "invoices", label: "Invoices & bills", icon: ReceiptText },
  { id: "loyalty", label: "Loyalty Tiers", icon: Star },
  { id: "security", label: "Security", icon: Lock },
  // { id: "notifications", label: "Notifications", icon: Bell },
  { id: "members", label: "Team Members", icon: Users },
  { id: "developers", label: "Developers", icon: DevelopersIcon },
  { id: "billing", label: "Billing & Plan", icon: BillingIcon },
  // { id: "appearance",    label: "Appearance",       icon: Palette },
];

const INDUSTRIES = [
  "Retail", "E-commerce", "Fashion", "Electronics", "Food & Beverage",
  "Health & Beauty", "Home & Garden", "Sports & Outdoors", "Technology",
  "Education", "Finance", "Healthcare", "Real Estate", "Travel & Hospitality", "Other",
];

const TIMEZONES = [
  { label: "UTC", value: "UTC" },
  { label: "America/New_York (EST)", value: "America/New_York" },
  { label: "America/Chicago (CST)", value: "America/Chicago" },
  { label: "America/Los_Angeles (PST)", value: "America/Los_Angeles" },
  { label: "Europe/London (GMT)", value: "Europe/London" },
  { label: "Europe/Paris (CET)", value: "Europe/Paris" },
  { label: "Asia/Kolkata (IST)", value: "Asia/Kolkata" },
  { label: "Asia/Tokyo (JST)", value: "Asia/Tokyo" },
  { label: "Asia/Dubai (GST)", value: "Asia/Dubai" },
  { label: "Australia/Sydney (AEST)", value: "Australia/Sydney" },
];

const CURRENCIES = [
  { label: "USD — US Dollar", value: "USD" },
  { label: "EUR — Euro", value: "EUR" },
  { label: "GBP — British Pound", value: "GBP" },
  { label: "INR — Indian Rupee", value: "INR" },
  { label: "JPY — Japanese Yen", value: "JPY" },
  { label: "CAD — Canadian Dollar", value: "CAD" },
  { label: "AUD — Australian Dollar", value: "AUD" },
  { label: "NGN — Nigerian Naira", value: "NGN" },
  { label: "AED — UAE Dirham", value: "AED" },
];

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "ADMIN", label: "Admin" },
  { value: "MANAGER", label: "Manager" },
  { value: "AGENT", label: "Agent" },
  { value: "VIEWER", label: "Viewer" },
  { value: "VENDOR", label: "Vendor" },
];

const OWNER_ADMIN_ONLY = "Only the workspace owner and admins can change these settings.";

const AVATAR_COLORS = [
  "bg-[#CEF17B] text-gray-900",
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-orange-100 text-orange-700",
  "bg-pink-100 text-pink-700",
  "bg-cyan-100 text-cyan-700",
];

// ── Reusable components ──────────────────────────────────────────────────────

/** A small toggle switch used for boolean settings. `label` is what screen readers call it. */
function Toggle({ enabled, onChange, label }: { enabled: boolean; onChange: () => void; label: string }) {
  return <Switch checked={enabled} onCheckedChange={() => onChange()} aria-label={label} />;
}

/** A card wrapper that groups related settings with a title and optional description. */
function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-card p-5 md:p-6 shadow-sm ring-1 ring-border">
      <div className="mb-5 border-b pb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * A labeled form field row with an optional hint, laid out in a responsive grid.
 * `htmlFor` is the control's id; the label's id is `${htmlFor}-label`, which a
 * Select trigger names itself with (aria-labelledby). A row that holds no
 * single control leaves it out.
 */
function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  const labelClass = "block text-xs font-medium text-gray-700 dark:text-gray-300";
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:items-start">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} id={`${htmlFor}-label`} className={labelClass}>{label}</label>
        ) : (
          <p className={labelClass}>{label}</p>
        )}
        {hint && <p className="mt-0.5 text-caption text-muted-foreground leading-snug">{hint}</p>}
      </div>
      <div className="sm:col-span-2">{children}</div>
    </div>
  );
}

/** A single notification preference row with toggles for email and push channels. */
function NotifRow({ label, hint, email, push }: { label: string; hint: string; email: boolean; push: boolean }) {
  const [emailEnabled, setEmailEnabled] = useState(email);
  const [pushEnabled, setPushEnabled] = useState(push);
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{label}</p>
        <p className="text-caption text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-6 shrink-0">
        <div className="flex flex-col items-center gap-1">
          <span className="text-caption text-muted-foreground">Email</span>
          <Toggle enabled={emailEnabled} onChange={() => setEmailEnabled((prev) => !prev)} label={`${label} by email`} />
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-caption text-muted-foreground">Push</span>
          <Toggle enabled={pushEnabled} onChange={() => setPushEnabled((prev) => !prev)} label={`${label} by push notification`} />
        </div>
      </div>
    </div>
  );
}

// ── Password schema ──────────────────────────────────────────────────────────

/** Zod schema for the change-password form with confirmation matching. */
const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Required"),
  newPassword: z.string().min(8, "Min. 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords do not match", path: ["confirmPassword"],
});
type PasswordForm = z.infer<typeof passwordSchema>;

// ── Invite dialog inline ─────────────────────────────────────────────────────

/** Which vendor a Vendor member supplies: they only see that vendor's products and orders. */
function VendorPicker({ value, onChange }: { value: string; onChange: (vendor: string) => void }) {
  // Distinct Product.vendor values to scope a vendor to.
  const { data: vendorOptions = [] } = useQuery({
    queryKey: ["products", "vendors"],
    queryFn: () => apiClient.get<string[]>("/products/vendors").then((r) => r.data),
  });

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Package className="size-3.5 shrink-0 text-gray-400" />
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="flex-1 h-9 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs shadow-sm">
            <SelectValue placeholder={vendorOptions.length ? "Select the vendor…" : "No vendors found in products"} />
          </SelectTrigger>
          <SelectContent>
            {vendorOptions.map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="pl-6 text-[10px] text-muted-foreground">
        This vendor will only see products and orders for <strong>{value || "the selected vendor"}</strong>.
      </p>
    </div>
  );
}

/** Inline form for inviting a new team member by email with a selected role. */
function InviteForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("AGENT");
  const [vendorScope, setVendorScope] = useState("");
  // Sections an Agent / Viewer starts with — everything, until unticked.
  const [sections, setSections] = useState<SectionId[]>(() => AVAILABLE_SECTIONS.map((s) => s.id));
  const [capabilities, setCapabilities] = useState<string[]>(DEFAULT_CAPABILITIES);
  const sendInvite = useSendInviteMutation(orgId);

  const needsVendor = role === "VENDOR";
  const needsSections = isSectionScopedRole(role);

  const canSend = !!email.trim() && (!needsVendor || !!vendorScope);

  function handleSendInvite() {
    if (!canSend) return;
    sendInvite.mutate(
      {
        email: email.trim(),
        role,
        vendorScope: needsVendor ? vendorScope : undefined,
        grants: needsSections ? accessGrants(role, sections, capabilities) : undefined,
      },
      { onSuccess: () => { setEmail(""); setVendorScope(""); onDone(); } },
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-[#CEF17B] bg-[#CEF17B]/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative basis-full sm:basis-auto sm:flex-1">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-gray-400 dark:text-gray-400" />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            className="w-full rounded-lg border border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-700 py-2 pl-9 pr-3 text-xs text-gray-900 dark:text-gray-100 placeholder:text-gray-400 shadow-sm outline-none focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40"
          />
        </div>
        <Select value={role} onValueChange={(selectedRole) => setRole(selectedRole as UserRole)}>
          <SelectTrigger className="w-[110px] h-9 shrink-0 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs shadow-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((roleOption) => (
              <SelectItem key={roleOption.value} value={roleOption.value}>{roleOption.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={handleSendInvite}
          disabled={sendInvite.isPending || !canSend}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors disabled:opacity-50"
        >
          {sendInvite.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Send"}
        </button>
        <button type="button" onClick={onDone} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X className="size-4" />
        </button>
      </div>

      {needsVendor && <VendorPicker value={vendorScope} onChange={setVendorScope} />}

      {needsSections && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[10px] font-medium text-muted-foreground">
            Sections this {role === "VIEWER" ? "viewer" : "agent"} can open — the rest show as locked
          </p>
          <SectionAccessPicker value={sections} onChange={setSections} />
          <CapabilityPicker role={role} sections={sections} value={capabilities} onChange={setCapabilities} />
        </div>
      )}
    </div>
  );
}

// ── Member access editor ────────────────────────────────────────────────────

const AVAILABLE_SECTION_KEYS = new Set(AVAILABLE_SECTIONS.map((s) => sectionKey(s.id)));

/** Short label for a grant list: how many of the sections it opens. */
function sectionAccessLabel(grants: string[] | undefined) {
  const granted = sectionsInGrants(grants ?? []).filter((id) => AVAILABLE_SECTION_KEYS.has(sectionKey(id)));
  if (sectionsInGrants(grants ?? []).length === 0) return "Full access";
  return `${granted.length} of ${AVAILABLE_SECTIONS.length} sections`;
}

/** Inline editor for which sections an Agent / Viewer can open. */
function MemberAccessEditor({ orgId, member, onDone }: { orgId: string; member: OrgMember; onDone: () => void }) {
  const grants = member.permissions ?? [];
  const configured = sectionsInGrants(grants);
  // Not configured yet = full access, so the editor opens with everything ticked.
  const [sections, setSections] = useState<SectionId[]>(() =>
    configured.length === 0
      ? AVAILABLE_SECTIONS.map((s) => s.id)
      : configured.filter((id) => AVAILABLE_SECTION_KEYS.has(sectionKey(id))),
  );
  const [capabilities, setCapabilities] = useState<string[]>(() => grants.filter((g) => MANAGED_CAPABILITY_KEYS.has(g)));
  const updatePermissions = useUpdateMemberPermissionsMutation(orgId);

  function handleSave() {
    // The endpoint replaces the whole list: keep every grant this editor does
    // not manage (inventory.*, and sections this build does not show).
    const kept = grants.filter((g) => !AVAILABLE_SECTION_KEYS.has(g) && !MANAGED_CAPABILITY_KEYS.has(g));
    updatePermissions.mutate(
      { memberId: member.id, data: { grants: [...kept, ...accessGrants(member.role, sections, capabilities)] } },
      { onSuccess: onDone },
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-[#CEF17B] bg-[#CEF17B]/5 p-3">
      <p className="text-[10px] font-medium text-muted-foreground">
        Sections {member.user.firstName} can open — the rest show as locked
        {configured.length === 0 && " (currently full access)"}
      </p>
      <SectionAccessPicker value={sections} onChange={setSections} disabled={updatePermissions.isPending} />
      <CapabilityPicker
        role={member.role}
        sections={sections}
        value={capabilities}
        onChange={setCapabilities}
        disabled={updatePermissions.isPending}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={updatePermissions.isPending || sections.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors disabled:opacity-50"
        >
          {updatePermissions.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Save access"}
        </button>
        <button type="button" onClick={onDone} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Vendor role dialog ──────────────────────────────────────────────────────

/** Moving a member to Vendor: the role needs the vendor they supply, so it is asked for first. */
function VendorRoleDialog({ orgId, member, onClose }: { orgId: string; member: OrgMember; onClose: () => void }) {
  const [vendorScope, setVendorScope] = useState("");
  const updateRole = useUpdateMemberRoleMutation(orgId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make {member.user.firstName} a vendor</DialogTitle>
          <DialogDescription>Choose which vendor {member.user.firstName} supplies.</DialogDescription>
        </DialogHeader>
        <VendorPicker value={vendorScope} onChange={setVendorScope} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!vendorScope || updateRole.isPending}
            onClick={() => updateRole.mutate({ memberId: member.id, data: { role: "VENDOR", vendorScope } }, { onSuccess: onClose })}
          >
            {updateRole.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Change role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Loyalty Tiers Tab ───────────────────────────────────────────────────────

const loyaltySchema = z.object({
  loyaltyMetric: z.enum(["ORDERS", "TOTAL_SPENT"]),
  loyaltyBronzeMin: z.coerce.number<number>().positive("Must be greater than 0"),
  loyaltySilverMin: z.coerce.number<number>().positive("Must be greater than 0"),
  loyaltyGoldMin: z.coerce.number<number>().positive("Must be greater than 0"),
  loyaltyPlatinumMin: z.coerce.number<number>().positive("Must be greater than 0"),
}).refine((v) => v.loyaltyBronzeMin < v.loyaltySilverMin, {
  path: ["loyaltySilverMin"], message: "Silver must be greater than Bronze",
}).refine((v) => v.loyaltySilverMin < v.loyaltyGoldMin, {
  path: ["loyaltyGoldMin"], message: "Gold must be greater than Silver",
}).refine((v) => v.loyaltyGoldMin < v.loyaltyPlatinumMin, {
  path: ["loyaltyPlatinumMin"], message: "Platinum must be greater than Gold",
});

type LoyaltyForm = z.infer<typeof loyaltySchema>;

function LoyaltyTab({ org }: { org: OrgResponse }) {
  const updateOrg = useUpdateOrganizationMutation(org.id);
  const recompute = useRecomputeLoyaltyMutation();
  const [confirmRecompute, setConfirmRecompute] = useState(false);

  const {
    register, handleSubmit, watch, reset,
    formState: { errors, isDirty },
  } = useForm<LoyaltyForm>({
    resolver: zodResolver(loyaltySchema),
    defaultValues: {
      loyaltyMetric: (org.loyaltyMetric ?? "ORDERS") as LoyaltyMetric,
      loyaltyBronzeMin: Number(org.loyaltyBronzeMin ?? 1),
      loyaltySilverMin: Number(org.loyaltySilverMin ?? 5),
      loyaltyGoldMin: Number(org.loyaltyGoldMin ?? 15),
      loyaltyPlatinumMin: Number(org.loyaltyPlatinumMin ?? 30),
    },
  });

  const metric = watch("loyaltyMetric");
  const unitLabel = metric === "ORDERS" ? "orders" : `${org.currency} spent`;
  const exampleValue = metric === "ORDERS" ? "5" : formatCurrency(500, org.currency, { minimumFractionDigits: 0 });

  function onSubmit(values: LoyaltyForm) {
    updateOrg.mutate(values, {
      onSuccess: () => reset(values),
    });
  }

  function handleRecompute() {
    setConfirmRecompute(false);
    recompute.mutate();
  }

  return (
    <>
      <Section
        title="Loyalty Tiers"
        description="Auto-categorize customers into Bronze / Silver / Gold / Platinum based on how much they've ordered."
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <Field
            label="Tier metric"
            hint="Which customer metric decides their tier?"
            htmlFor="loyalty-metric"
          >
            <Select
              value={metric}
              onValueChange={(value) => {
                // react-hook-form's setValue via register doesn't hook into a ui Select
                // so write through the form ref.
                reset({ ...watch(), loyaltyMetric: value as LoyaltyMetric }, { keepDirty: true });
              }}
            >
              <SelectTrigger id="loyalty-metric" aria-labelledby="loyalty-metric-label" className="h-9 w-full border-input bg-white dark:bg-gray-900 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ORDERS">Orders placed</SelectItem>
                <SelectItem value="TOTAL_SPENT">Total spent</SelectItem>
              </SelectContent>
            </Select>
            {metric === "TOTAL_SPENT" && (
              <p className="mt-1.5 text-[10px] text-orange-600">
                Total spent is in each customer's original order currency. For multi-currency orgs, prefer Orders.
              </p>
            )}
          </Field>

          {(["loyaltyBronzeMin", "loyaltySilverMin", "loyaltyGoldMin", "loyaltyPlatinumMin"] as const).map((name) => {
            const tierLabel = name.replace("loyalty", "").replace("Min", "");
            return (
              <Field
                key={name}
                label={`${tierLabel} minimum`}
                hint={`Customers at or above this ${unitLabel} become ${tierLabel}. (e.g. ${exampleValue})`}
                htmlFor={name}
              >
                <input
                  id={name}
                  type="number"
                  // step={metric === "ORDERS" ? "1" : "0.01"}
                  min="1"
                  aria-invalid={!!errors[name]}
                  aria-describedby={errors[name] ? `${name}-error` : undefined}
                  {...register(name, { valueAsNumber: true })}
                  className="h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-900 px-3 text-xs text-gray-900 dark:text-gray-100 shadow-sm focus:border-[#CEF17B] focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/40"
                />
                {errors[name] && (
                  <p id={`${name}-error`} className="mt-1 text-[10px] text-red-500">{errors[name]?.message as string}</p>
                )}
              </Field>
            );
          })}

          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <p className="text-caption text-muted-foreground">
              Saving changes only stores the new thresholds — click "Recompute tiers" to apply them to existing customers.
            </p>
            <button
              type="submit"
              disabled={!isDirty || updateOrg.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {updateOrg.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save thresholds
            </button>
          </div>
        </form>
      </Section>

      <Section
        title="Recompute all customer tiers"
        description="Re-evaluates every customer's tier against the current thresholds. Run this after changing thresholds or the metric."
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-caption text-muted-foreground">
            {isDirty
              ? "Save your thresholds first before recomputing."
              : "New orders sync their customer's tier automatically. Use this for a one-time catch-up across all customers."}
          </p>
          <button
            type="button"
            onClick={() => setConfirmRecompute(true)}
            disabled={isDirty || recompute.isPending}
            className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-lg border border-input bg-white dark:bg-gray-900 px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {recompute.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Star className="size-3.5" />}
            Recompute tiers
          </button>
        </div>
      </Section>

      {confirmRecompute && (
        <ModalFrame
          onClose={() => setConfirmRecompute(false)}
          describedBy="recompute-tiers-help"
          className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-900 p-5 shadow-xl outline-none"
        >
            <ModalTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recompute customer tiers?</ModalTitle>
            <p id="recompute-tiers-help" className="mt-1 text-xs text-muted-foreground">
              Every customer will be re-evaluated against the current thresholds. Manual VIP overrides will be replaced.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRecompute(false)}
                className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRecompute}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors"
              >
                <Check className="size-3.5" /> Recompute
              </button>
            </div>
        </ModalFrame>
      )}
    </>
  );
}

// ── Appearance tab ──────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", icon: Sun, desc: "Clean light interface with white backgrounds" },
  { value: "dark" as const, label: "Dark", icon: Moon, desc: "Easy on the eyes with dark backgrounds" },
  { value: "system" as const, label: "System", icon: Monitor, desc: "Automatically match your OS preference" },
];

/** Appearance settings tab with theme selection, accent color, and layout options. */
// ── Tax & GST Tab ───────────────────────────────────────────────────────────

// Must stay in step with GST_RATE_SLABS on the server, which now ENFORCES this
// set. 0.25% (rough diamonds) and 3% (gold, silver, jewellery) are real slabs
// that were missing here — without them a jewellery merchant cannot select the
// rate the server would accept.
const GST_RATE_OPTIONS = ["0", "0.25", "3", "5", "12", "18", "28"];

/**
 * The places of business operating under one registration: the principal one
 * (the registered address) plus every warehouse declared as an additional
 * place of business (APOB) of it.
 *
 * This is the view a merchant needs before filing — GST registers per STATE,
 * and every branch invoicing under a GSTIN must be declared on the portal
 * under that same registration.
 */
function PlacesOfBusiness({
  gstin,
  warehouses,
}: {
  gstin: OrganizationGstin;
  warehouses: Warehouse[];
}) {
  const principal = readAddress(gstin.address);
  const additional = warehouses.filter((w) => w.gstinId === gstin.id);

  return (
    <div className="mt-2 space-y-1 border-l-2 border-gray-100 dark:border-gray-800 pl-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">
        Places of business
      </p>
      <p className="text-caption text-muted-foreground">
        <span className="text-gray-600 dark:text-gray-400">Principal:</span>{" "}
        {principal.hasAddress ? principal.lines.join(", ") : "No registered address"}
      </p>
      {additional.map((w) => (
        <p key={w.id} className="text-caption text-muted-foreground">
          <LocationKindBadge kind={w.kind} className="mr-1 align-middle" />
          <span className="text-gray-600 dark:text-gray-400">{w.name}:</span>{" "}
          {readAddress(w.address).lines.join(", ") || "No address"}
          {!w.apobDeclared && (
            <span className="ml-1 rounded bg-amber-50 px-1 text-[9px] text-amber-700">
              not declared on portal
            </span>
          )}
        </p>
      ))}
    </div>
  );
}

function TaxGstTab({ orgId, gstEnabled: initialGstEnabled }: { orgId: string; gstEnabled: boolean }) {
  const [gstEnabled, setGstEnabled] = useState(initialGstEnabled);
  const [showAddForm, setShowAddForm] = useState(false);
  const updateOrg = useUpdateOrganizationMutation(orgId);
  const { data: gstins = [], isLoading: gstinsLoading } = useGstins();
  const { data: states = [] } = useIndianStates();
  const createGstin = useCreateGstinMutation();
  const deleteGstin = useDeleteGstinMutation();
  const updateGstin = useUpdateGstinMutation();

  // Form state for adding GSTIN
  const EMPTY_GSTIN_FORM: CreateGstinRequest = {
    gstin: "", legalName: "", tradeName: "", stateCode: "", stateName: "", isDefault: false,
    address: {},
  };
  const [form, setForm] = useState<CreateGstinRequest>(EMPTY_GSTIN_FORM);
  // Id of the registration being edited, or null when the form is adding a new
  // one. The same form serves both — the PATCH endpoint already accepted every
  // field, there was simply no way to reach it from the UI.
  const [editingId, setEditingId] = useState<string | null>(null);

  function startEdit(g: OrganizationGstin) {
    setEditingId(g.id);
    setShowAddForm(true);
    setForm({
      gstin: g.gstin,
      legalName: g.legalName,
      tradeName: g.tradeName ?? "",
      stateCode: g.stateCode,
      stateName: g.stateName,
      isDefault: g.isDefault,
      address: (g.address as CreateGstinRequest["address"]) ?? {},
    });
  }

  function closeGstinForm() {
    setShowAddForm(false);
    setEditingId(null);
    setForm(EMPTY_GSTIN_FORM);
  }

  /** Open the form blank — never carrying values left over from an edit. */
  function startAdd() {
    setEditingId(null);
    setForm(EMPTY_GSTIN_FORM);
    setShowAddForm(true);
  }

  // Removing a registration is one unguarded click on a small icon, and it
  // changes which GSTIN invoices are issued under. Confirm first.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function patchAddress(patch: Partial<NonNullable<CreateGstinRequest["address"]>>) {
    setForm((prev) => ({ ...prev, address: { ...prev.address, ...patch } }));
  }

  function handleGstToggle() {
    const newValue = !gstEnabled;
    setGstEnabled(newValue);
    updateOrg.mutate({ gstEnabled: newValue });
  }

  function handleAddGstin() {
    if (!form.gstin || !form.legalName || !form.stateCode) {
      toast.error("Please fill in GSTIN, legal name, and state.");
      return;
    }
    // Drop blank address keys, and send `undefined` rather than `{}` when the
    // address was left untouched — an empty object would still be stored, and
    // `readAddress` reports `hasAddress: false` either way, so the record would
    // just carry noise. `province` comes from the state picker, so the printed
    // address names the state without needing a second input. The `> 1` check
    // means "something beyond the auto-filled province was actually typed".
    const address = Object.fromEntries(
      Object.entries({ ...form.address, province: form.stateName })
        .filter(([, value]) => typeof value === "string" && value.trim() !== ""),
    );

    const payload = {
      ...form,
      address: Object.keys(address).length > 1 ? address : undefined,
    };

    if (editingId) {
      updateGstin.mutate(
        { id: editingId, data: payload },
        { onSuccess: closeGstinForm },
      );
      return;
    }

    createGstin.mutate(payload, { onSuccess: closeGstinForm });
  }

  function handleStateChange(code: string) {
    const state = states.find((s) => s.code === code);
    setForm((prev) => ({ ...prev, stateCode: code, stateName: state?.name || "" }));
  }

  const activeGstins = gstins.filter((g: OrganizationGstin) => g.isActive);

  // Composed client-side rather than through a new endpoint: this is two lists
  // the app already fetches. Renders nothing extra when the warehouses query
  // fails or is forbidden (it needs inventory.view, which this tab does not).
  const warehouses = useWarehouses();
  const warehouseRows = (warehouses.data ?? []).filter((w) => w.isActive);
  const unlinkedWarehouses = warehouseRows.filter((w) => !w.gstinId).length;
  const undeclaredWarehouses = warehouseRows.filter(
    (w) => w.gstinId && !w.apobDeclared,
  ).length;

  const confirmDelete = activeGstins.find(
    (g: OrganizationGstin) => g.id === confirmDeleteId,
  );

  return (
    <>
      {/* GST Toggle */}
      <Section title="GST Status" description="Enable GST to generate tax-compliant invoices for Indian businesses.">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Enable GST</p>
            <p className="text-caption text-muted-foreground">When enabled, you can register GSTINs and generate GST invoices.</p>
          </div>
          <Toggle enabled={gstEnabled} onChange={handleGstToggle} label="Enable GST" />
        </div>
      </Section>

      {/* GSTIN Registrations */}
      {gstEnabled && (
        <Section title="GSTIN Registrations" description="Add your GST Identification Numbers for each state where your business is registered.">
          {/* GSTIN List */}
          {gstinsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : activeGstins.length === 0 && !showAddForm ? (
            <div className="py-8 text-center">
              <Receipt className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No GSTIN registered yet.</p>
              <button
                onClick={startAdd}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#cdff8c] px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] transition-colors"
              >
                <Plus className="size-3.5" /> Add GSTIN
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {activeGstins.map((g: OrganizationGstin) => (
                  <div
                    key={g.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-mono font-semibold text-gray-900 dark:text-gray-100">
                          {g.gstin}
                        </p>
                        {g.isDefault && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-[#cdff8c]/30 px-1.5 py-0.5 text-[9px] font-medium text-[#4d7a00]">
                            <Star className="size-2.5" /> Default
                          </span>
                        )}
                      </div>
                      <p className="text-caption text-muted-foreground mt-0.5">
                        {g.legalName} {g.tradeName ? `(${g.tradeName})` : ""}
                      </p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <MapPin className="size-2.5 text-muted-foreground" />
                        <p className="text-caption text-muted-foreground">
                          {g.stateName} ({g.stateCode})
                        </p>
                      </div>
                      <PlacesOfBusiness gstin={g} warehouses={warehouseRows} />
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!g.isDefault && (
                        <button
                          onClick={() => updateGstin.mutate({ id: g.id, data: { isDefault: true } })}
                          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          title="Set as default"
                        >
                          Set Default
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(g)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-gray-100 transition-colors"
                        title="Edit registration"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(g.id)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 transition-colors"
                        title="Remove registration"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Warehouses that invoice but are not attached to any
                  registration, and linked ones the merchant has not yet
                  declared on the portal. Both are compliance gaps this app can
                  only point at — the portal amendment is theirs to file. */}
              {(unlinkedWarehouses > 0 || undeclaredWarehouses > 0) && (
                <div className="mt-3 space-y-1">
                  {unlinkedWarehouses > 0 && (
                    <p className="text-caption text-muted-foreground">
                      {unlinkedWarehouses} warehouse{unlinkedWarehouses === 1 ? " is" : "s are"} not linked to a GST registration.{" "}
                      <Link to="/products/inventory/warehouses" className="underline hover:text-gray-900 dark:hover:text-gray-100">
                        Link them
                      </Link>
                    </p>
                  )}
                  {undeclaredWarehouses > 0 && (
                    <p className="text-caption text-muted-foreground">
                      {undeclaredWarehouses} place{undeclaredWarehouses === 1 ? "" : "s"} of business not yet marked as declared on the GST portal.
                    </p>
                  )}
                </div>
              )}

              {/* Add button */}
              {!showAddForm && (
                <button
                  onClick={startAdd}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs text-muted-foreground hover:border-[#cdff8c] hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                >
                  <Plus className="size-3.5" /> Add another GSTIN
                </button>
              )}
            </>
          )}

          {/* Add GSTIN Form */}
          {showAddForm && (
            <div className="mt-4 space-y-3 rounded-lg border border-dashed border-[#cdff8c] bg-[#cdff8c]/5 p-4">
              <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                {editingId ? "Edit GSTIN Registration" : "Add GSTIN Registration"}
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="gstin-form-gstin" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">GSTIN *</label>
                  <input
                    id="gstin-form-gstin"
                    value={form.gstin}
                    onChange={(e) => setForm((prev) => ({ ...prev, gstin: e.target.value.toUpperCase() }))}
                    placeholder="e.g. 27AABCU9603R1ZM"
                    maxLength={15}
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs font-mono outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
                <div>
                  <label id="gstin-form-state-label" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">State *</label>
                  <Select value={form.stateCode} onValueChange={handleStateChange}>
                    <SelectTrigger aria-labelledby="gstin-form-state-label" className="mt-1 h-9 text-xs">
                      <SelectValue placeholder="Select state" />
                    </SelectTrigger>
                    <SelectContent>
                      {states.map((s) => (
                        <SelectItem key={s.code} value={s.code} className="text-xs">
                          {s.code} - {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label htmlFor="gstin-form-legal-name" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Legal Name *</label>
                  <input
                    id="gstin-form-legal-name"
                    value={form.legalName}
                    onChange={(e) => setForm((prev) => ({ ...prev, legalName: e.target.value }))}
                    placeholder="Registered legal name"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
                <div>
                  <label htmlFor="gstin-form-trade-name" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Trade Name</label>
                  <input
                    id="gstin-form-trade-name"
                    value={form.tradeName || ""}
                    onChange={(e) => setForm((prev) => ({ ...prev, tradeName: e.target.value }))}
                    placeholder="Brand/trade name (optional)"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
              </div>

              {/* Registered address. A GST tax invoice must carry the
                  supplier's address, and this form was the missing link: the
                  DTO and the Prisma column already accepted one, so every
                  invoice snapshotted a null sellerAddress and printed without
                  it. Keys match the canonical shape lib/address.ts reads. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <p className="sm:col-span-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Registered address — printed on every invoice issued under this GSTIN
                </p>
                <div className="sm:col-span-2">
                  <label htmlFor="gstin-form-address1" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Address line 1</label>
                  <input
                    id="gstin-form-address1"
                    value={form.address?.address1 ?? ""}
                    onChange={(e) => patchAddress({ address1: e.target.value })}
                    placeholder="Building, street"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="gstin-form-address2" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Address line 2</label>
                  <input
                    id="gstin-form-address2"
                    value={form.address?.address2 ?? ""}
                    onChange={(e) => patchAddress({ address2: e.target.value })}
                    placeholder="Area, landmark (optional)"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
                <div>
                  <label htmlFor="gstin-form-city" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">City</label>
                  <input
                    id="gstin-form-city"
                    value={form.address?.city ?? ""}
                    onChange={(e) => patchAddress({ city: e.target.value })}
                    placeholder="City"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
                <div>
                  <label htmlFor="gstin-form-zip" className="text-[10px] font-medium text-gray-600 dark:text-gray-400">PIN code</label>
                  <input
                    id="gstin-form-zip"
                    value={form.address?.zip ?? ""}
                    onChange={(e) => patchAddress({ zip: e.target.value })}
                    placeholder="6-digit PIN"
                    className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-[10px] text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={form.isDefault || false}
                  onChange={(e) => setForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                  className="rounded border-gray-300"
                />
                Set as default GSTIN
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleAddGstin}
                  disabled={createGstin.isPending || updateGstin.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#cdff8c] px-4 py-2 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] disabled:opacity-50 transition-colors"
                >
                  {createGstin.isPending || updateGstin.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  {editingId ? "Save changes" : "Save GSTIN"}
                </button>
                <button
                  onClick={closeGstinForm}
                  className="rounded-lg px-4 py-2 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Composition scheme and e-invoicing: which documents get issued at all. */}
      {gstEnabled && <TaxSchemeSetting />}

      {/* State Base Tax Rates */}
      {gstEnabled && (
        <StateTaxRatesSection />
      )}

      {/* Product Type Tax Rates */}
      {gstEnabled && (
        <ProductTypeTaxRatesSection />
      )}

      {/* Collection Tax Overrides */}
      {gstEnabled && (
        <CollectionOverridesSection />
      )}

      {/* Whether catalogue and typed prices already contain GST. */}
      {gstEnabled && <CatalogPricesSetting />}

      {/* GST return settings — B2CL threshold and default UQC. */}
      {gstEnabled && <GstReturnSettings />}

      {/* Invoice series prefix. Statutory output, same as the return settings
          above, so it lives behind the same manager-gated route. */}
      {gstEnabled && <InvoiceSeriesSetting />}

      {/* Remove-registration confirmation. Same shape as the recompute-tiers
          confirm above, so the page has one way of asking. */}
      {confirmDelete && (
        <ModalFrame
          onClose={() => setConfirmDeleteId(null)}
          describedBy="remove-gstin-help"
          className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-900 p-5 shadow-xl outline-none"
        >
            <ModalTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Remove this GSTIN registration?
            </ModalTitle>
            <p className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">
              {confirmDelete.gstin}
            </p>
            <p id="remove-gstin-help" className="mt-2 text-xs text-muted-foreground">
              New invoices can no longer be issued under it. Invoices already issued keep it,
              and you can add the same number back later to restore this registration.
            </p>
            {confirmDelete.isDefault && (
              <p className="mt-2 text-xs text-muted-foreground">
                It is your default registration, so the oldest remaining one becomes the
                default in its place.
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteGstin.isPending}
                onClick={() =>
                  deleteGstin.mutate(confirmDelete.id, {
                    onSuccess: () => setConfirmDeleteId(null),
                  })
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteGstin.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Remove
              </button>
            </div>
        </ModalFrame>
      )}
    </>
  );
}

// ── State Tax Rates Section ─────────────────────────────────────────────────

function StateTaxRatesSection() {
  const [showAddForm, setShowAddForm] = useState(false);
  const [stateCode, setStateCode] = useState("");
  const [gstRate, setGstRate] = useState("");
  const { data: taxRates = [], isLoading } = useStateTaxRates();
  const { data: states = [] } = useIndianStates();
  const createRate = useCreateStateTaxRateMutation();
  const deleteRate = useDeleteStateTaxRateMutation();
  const updateRate = useUpdateStateTaxRateMutation();

  function handleAdd() {
    if (!stateCode || !gstRate) { toast.error("Select a state and GST rate."); return; }
    createRate.mutate({ stateCode, gstRate: parseFloat(gstRate) }, {
      onSuccess: () => { setShowAddForm(false); setStateCode(""); setGstRate(""); },
    });
  }

  // Filter out states that already have rates
  const existingCodes = new Set(taxRates.map((r: StateTaxRate) => r.stateCode));
  const availableStates = states.filter((s) => !existingCodes.has(s.code));

  return (
    <Section title="State Base Tax Rates" description="Set default GST rates per state. Used when no product-level or collection-level rate is configured.">
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : taxRates.length === 0 && !showAddForm ? (
        <div className="py-6 text-center">
          <p className="text-xs text-muted-foreground">No state tax rates configured.</p>
          <button onClick={() => setShowAddForm(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#cdff8c] px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] transition-colors">
            <Plus className="size-3.5" /> Add State Rate
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {taxRates.map((rate: StateTaxRate) => (
              <div key={rate.id} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{rate.stateName}</p>
                  <p className="text-caption text-muted-foreground">State Code: {rate.stateCode}</p>
                </div>
                <div className="flex items-center gap-3">
                  {/* Editable in place. The update mutation existed and was
                      never imported, so changing a rate meant delete-then-
                      recreate — which loses the row id and reads as a deletion
                      in any audit of who changed what. */}
                  <Select
                    value={String(Number(rate.gstRate))}
                    onValueChange={(next) =>
                      updateRate.mutate({ id: rate.id, data: { gstRate: Number(next) } })
                    }
                  >
                    <SelectTrigger className="h-7 w-20 text-xs" aria-label={`GST rate for ${rate.stateName}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GST_RATE_OPTIONS.map((r) => (
                        <SelectItem key={r} value={r} className="text-xs">{r}%</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button onClick={() => deleteRate.mutate(rate.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 transition-colors">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!showAddForm && (
            <button onClick={() => setShowAddForm(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs text-muted-foreground hover:border-[#cdff8c] hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
              <Plus className="size-3.5" /> Add State Rate
            </button>
          )}
        </>
      )}

      {showAddForm && (
        <div className="mt-3 flex items-end gap-3 rounded-lg border border-dashed border-[#cdff8c] bg-[#cdff8c]/5 p-4">
          <div className="flex-1">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">State</label>
            <Select value={stateCode} onValueChange={setStateCode}>
              <SelectTrigger aria-label="State" className="mt-1 h-9 text-xs"><SelectValue placeholder="Select state" /></SelectTrigger>
              <SelectContent>
                {availableStates.map((s) => (
                  <SelectItem key={s.code} value={s.code} className="text-xs">{s.code} - {s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">GST Rate</label>
            <Select value={gstRate} onValueChange={setGstRate}>
              <SelectTrigger aria-label="GST rate" className="mt-1 h-9 text-xs"><SelectValue placeholder="Rate" /></SelectTrigger>
              <SelectContent>
                {GST_RATE_OPTIONS.map((r) => (<SelectItem key={r} value={r} className="text-xs">{r}%</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <button onClick={handleAdd} disabled={createRate.isPending} className="inline-flex h-9 items-center gap-1 rounded-lg bg-[#cdff8c] px-3 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] disabled:opacity-50">
            {createRate.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Add
          </button>
          <button onClick={() => setShowAddForm(false)} className="h-9 rounded-lg px-3 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
        </div>
      )}
    </Section>
  );
}

// ── Product Type Tax Rates Section ──────────────────────────────────────────

function ProductTypeTaxRatesSection() {
  const [showAddForm, setShowAddForm] = useState(false);
  const [productType, setProductType] = useState("");
  const [gstRate, setGstRate] = useState("");
  const { data: taxRates = [], isLoading } = useProductTypeTaxRates();
  const { data: productTypes = [] } = useProductTypes();
  const createRate = useCreateProductTypeTaxRateMutation();
  const deleteRate = useDeleteProductTypeTaxRateMutation();

  function handleAdd() {
    if (!productType || !gstRate) { toast.error("Select a product type and GST rate."); return; }
    createRate.mutate({ productType, gstRate: parseFloat(gstRate) }, {
      onSuccess: () => { setShowAddForm(false); setProductType(""); setGstRate(""); },
    });
  }

  // Filter out product types that already have rates
  const existingTypes = new Set(taxRates.map((r: ProductTypeTaxRate) => r.productType));
  const availableTypes = (productTypes as string[]).filter((t) => !existingTypes.has(t));

  return (
    <Section title="Product Type Tax Rates" description="Set default GST rates by product type (e.g., T-Shirts = 12%, Electronics = 18%). Overrides state base rates.">
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : taxRates.length === 0 && !showAddForm ? (
        <div className="py-6 text-center">
          <p className="text-xs text-muted-foreground">No product type tax rates configured.</p>
          <button onClick={() => setShowAddForm(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#cdff8c] px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] transition-colors">
            <Plus className="size-3.5" /> Add Product Type Rate
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {taxRates.map((rate: ProductTypeTaxRate) => (
              <div key={rate.id} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{rate.productType}</p>
                  <p className="text-caption text-muted-foreground">Product type</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-400">{Number(rate.gstRate)}%</span>
                  <button onClick={() => deleteRate.mutate(rate.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 transition-colors">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!showAddForm && (
            <button onClick={() => setShowAddForm(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs text-muted-foreground hover:border-[#cdff8c] hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
              <Plus className="size-3.5" /> Add Product Type Rate
            </button>
          )}
        </>
      )}

      {showAddForm && (
        <div className="mt-3 flex items-end gap-3 rounded-lg border border-dashed border-[#cdff8c] bg-[#cdff8c]/5 p-4">
          <div className="flex-1">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Product Type</label>
            <Select value={productType} onValueChange={setProductType}>
              <SelectTrigger aria-label="Product type" className="mt-1 h-9 text-xs"><SelectValue placeholder="Select product type" /></SelectTrigger>
              <SelectContent>
                {availableTypes.length > 0 ? (
                  availableTypes.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                  ))
                ) : (
                  <SelectItem value="_none" disabled className="text-xs text-muted-foreground">No product types available</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">GST Rate</label>
            <Select value={gstRate} onValueChange={setGstRate}>
              <SelectTrigger aria-label="GST rate" className="mt-1 h-9 text-xs"><SelectValue placeholder="Rate" /></SelectTrigger>
              <SelectContent>
                {GST_RATE_OPTIONS.map((r) => (<SelectItem key={r} value={r} className="text-xs">{r}%</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <button onClick={handleAdd} disabled={createRate.isPending} className="inline-flex h-9 items-center gap-1 rounded-lg bg-[#cdff8c] px-3 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] disabled:opacity-50">
            {createRate.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Add
          </button>
          <button onClick={() => setShowAddForm(false)} className="h-9 rounded-lg px-3 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
        </div>
      )}
    </Section>
  );
}

// ── Collection Tax Overrides Section ────────────────────────────────────────

function CollectionOverridesSection() {
  const [showAddForm, setShowAddForm] = useState(false);
  const [collectionId, setCollectionId] = useState("");
  const [gstRate, setGstRate] = useState("");
  const { data: collections = [], isLoading: collectionsLoading } = useCollections();
  const { data: overrides = [], isLoading: overridesLoading } = useCollectionOverrides();
  const createOverride = useCreateCollectionOverrideMutation();
  const deleteOverride = useDeleteCollectionOverrideMutation();

  function handleAdd() {
    if (!collectionId || !gstRate) { toast.error("Select a collection and GST rate."); return; }
    createOverride.mutate({ collectionId, gstRate: parseFloat(gstRate) }, {
      onSuccess: () => { setShowAddForm(false); setCollectionId(""); setGstRate(""); },
    });
  }

  // Filter out collections that already have overrides
  const existingIds = new Set(overrides.map((o: CollectionTaxOverride) => o.collectionId));
  const availableCollections = collections.filter((c: ShopifyCollection) => !existingIds.has(c.id));
  const isLoading = collectionsLoading || overridesLoading;

  return (
    <Section title="Collection Tax Overrides" description="Override GST rate for all products in a Shopify collection. Overrides state base rates but not individual product rates.">
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : collections.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-xs text-muted-foreground">No Shopify collections synced yet.</p>
          <p className="mt-1 text-[10px] text-muted-foreground">Sync your collections from the Channels page first.</p>
        </div>
      ) : overrides.length === 0 && !showAddForm ? (
        <div className="py-6 text-center">
          <p className="text-xs text-muted-foreground">No collection overrides configured.</p>
          <button onClick={() => setShowAddForm(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#cdff8c] px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] transition-colors">
            <Plus className="size-3.5" /> Add Override
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {overrides.map((override: CollectionTaxOverride) => (
              <div key={override.id} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{override.collection?.title ?? "Unknown"}</p>
                  <p className="text-caption text-muted-foreground">Collection override</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 text-xs font-semibold text-purple-700 dark:text-purple-400">{Number(override.gstRate)}%</span>
                  <button onClick={() => deleteOverride.mutate(override.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 transition-colors">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!showAddForm && availableCollections.length > 0 && (
            <button onClick={() => setShowAddForm(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs text-muted-foreground hover:border-[#cdff8c] hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
              <Plus className="size-3.5" /> Add Override
            </button>
          )}
        </>
      )}

      {showAddForm && (
        <div className="mt-3 flex items-end gap-3 rounded-lg border border-dashed border-[#cdff8c] bg-[#cdff8c]/5 p-4">
          <div className="flex-1">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">Collection</label>
            <Select value={collectionId} onValueChange={setCollectionId}>
              <SelectTrigger aria-label="Collection" className="mt-1 h-9 text-xs"><SelectValue placeholder="Select collection" /></SelectTrigger>
              <SelectContent>
                {availableCollections.map((c: ShopifyCollection) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">{c.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28">
            <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">GST Rate</label>
            <Select value={gstRate} onValueChange={setGstRate}>
              <SelectTrigger aria-label="GST rate" className="mt-1 h-9 text-xs"><SelectValue placeholder="Rate" /></SelectTrigger>
              <SelectContent>
                {GST_RATE_OPTIONS.map((r) => (<SelectItem key={r} value={r} className="text-xs">{r}%</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <button onClick={handleAdd} disabled={createOverride.isPending} className="inline-flex h-9 items-center gap-1 rounded-lg bg-[#cdff8c] px-3 text-xs font-medium text-gray-900 hover:bg-[#b8e67d] disabled:opacity-50">
            {createOverride.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Add
          </button>
          <button onClick={() => setShowAddForm(false)} className="h-9 rounded-lg px-3 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
        </div>
      )}
    </Section>
  );
}

function AppearanceTab() {
  const { theme, setTheme } = useThemeStore();

  return (
    <>
      <Section title="Theme" description="Choose your preferred color mode for the interface.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map(({ value, label, icon: Icon, desc }) => {
            const isActive = theme === value;
            return (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={cn(
                  "group relative flex flex-col items-center gap-3 rounded-xl border-2 p-5 text-center transition-all",
                  isActive
                    ? "border-[#CEF17B] bg-[#CEF17B]/10 dark:bg-[#CEF17B]/5"
                    : "border-transparent bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800"
                )}
              >
                {/* Preview card */}
                <div className={cn(
                  "flex size-16 items-center justify-center rounded-xl shadow-sm ring-1 transition-colors",
                  value === "light"
                    ? "bg-white ring-gray-200"
                    : value === "dark"
                      ? "bg-gray-900 ring-gray-700"
                      : "bg-gradient-to-br from-white to-gray-900 ring-gray-300"
                )}>
                  <Icon className={cn(
                    "size-6",
                    value === "light" ? "text-amber-500" : value === "dark" ? "text-blue-400" : "text-gray-500"
                  )} />
                </div>

                <div>
                  <p className={cn(
                    "text-sm font-semibold",
                    isActive ? "text-[#084734] dark:text-[#CEF17B]" : "text-gray-900 dark:text-gray-100"
                  )}>
                    {label}
                  </p>
                  <p className="mt-0.5 text-caption text-muted-foreground leading-snug">{desc}</p>
                </div>

                {/* Checkmark */}
                {isActive && (
                  <div className="absolute top-2.5 right-2.5 flex size-5 items-center justify-center rounded-full bg-[#CEF17B]">
                    <Check className="size-3 text-gray-900" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Accent Color" description="Used for buttons, highlights, and active states.">
        <div className="flex items-center gap-3">
          {["#CEF17B", "#60a5fa", "#f472b6", "#fb923c", "#a78bfa", "#34d399"].map((color) => (
            <button
              key={color}
              className={cn(
                "size-8 rounded-full ring-2 ring-offset-2 dark:ring-offset-gray-900 transition-all",
                color === "#CEF17B" ? "ring-gray-900 dark:ring-gray-100" : "ring-transparent hover:ring-gray-300"
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Accent color customization coming soon. Currently using green.
        </p>
      </Section>

      <Section title="Layout" description="How the navigation is displayed.">
        <Field label="Navigation Style" hint="Choose how the main navigation appears." htmlFor="navigation-style">
          <Select defaultValue="top">
            <SelectTrigger id="navigation-style" aria-labelledby="navigation-style-label" className="h-9 w-full rounded-lg border border-input bg-transparent dark:bg-gray-900 dark:text-gray-100 px-3 text-sm focus:ring-2 focus:ring-[#CEF17B]/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="top">Top navigation (current)</SelectItem>
              <SelectItem value="left">Left sidebar</SelectItem>
              <SelectItem value="compact">Compact sidebar</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Layout customization coming soon.
        </p>
      </Section>
    </>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

/** Main settings page with tabbed navigation for workspace, security, and preferences. */
export default function SettingsPage() {
  const navigate = useNavigate();
  const { tab } = useParams();
  const activeTab = TABS.some((t) => t.id === tab) ? tab! : "general";
  // Settings tabs an influencer may open. Anything else is an organization
  // setting they have no business in, and the layout would bounce them off it
  // anyway — listing it would just be a dead link. Channels is why they are
  // here; Security is their own password.
  const INFLUENCER_TABS = ["channels", "security"];
  const [showInvite, setShowInvite] = useState(false);
  // Member whose section-access editor is open.
  const [accessMemberId, setAccessMemberId] = useState<string | null>(null);
  // Member being moved to Vendor, while their vendor is chosen.
  const [vendorMember, setVendorMember] = useState<OrgMember | null>(null);
  /**
   * Drives the org-setup sheet:
   *   - `null`     — sheet closed
   *   - `"default"` — open with the choice step (upgrade vs create). Used by
   *                   PERSONAL workspaces where both options are valid.
   *   - `"create"` — open straight on the create-org form (skip choice). Used
   *                   by ORGANIZATION workspaces, where "upgrade" isn't valid.
   */
  const [orgSheetMode, setOrgSheetMode] = useState<"default" | "create" | null>(null);

  const authUser = useAuthStore((state) => state.user);
  const currentOrgId = useAuthStore((state) => state.currentOrgId);
  const logout = useAuthStore((state) => state.logout);

  // Org data
  const { data: org, isLoading: orgLoading } = useCurrentOrg();
  const { data: members, isLoading: membersLoading } = useOrgMembers(currentOrgId);
  const { role: memberRole, isInfluencer } = useCurrentRole();
  const { data: invites } = useOrgInvites(currentOrgId, memberRole === "OWNER" || memberRole === "ADMIN");
  const { canAccess } = useSectionAccess();
  // Who may change the workspace (name, localization) and its team (invites,
  // roles, removal), and see billing and developer keys. The server is the
  // real boundary (`requireRole` / @Roles on each route); this hides
  // affordances that would only be refused.
  const canManageTeam = memberRole === "OWNER" || memberRole === "ADMIN";
  // Inbox settings are for members who can open the Inbox; billing and
  // developers for owners and admins.
  const visibleTabs = isInfluencer
    ? TABS.filter((t) => INFLUENCER_TABS.includes(t.id))
    : TABS.filter((t) => (t.id !== "inbox" || canAccess("/inbox")) && ((t.id !== "billing" && t.id !== "developers") || canManageTeam));
  // Staff only. Influencers hold a membership like anyone else, but they are an
  // outside party managed in their own section, with their own lifecycle.
  const staffMembers = (members ?? []).filter((m) => m.role !== "INFLUENCER");
  // Same reason: an influencer's invitation belongs in the influencer table,
  // not in the pending-team-invitations list beside it.
  const staffInvites = (invites ?? []).filter((i) => i.role !== "INFLUENCER");

  // ── Mutations for organization, member, and invite operations ──
  const updateOrg = useUpdateOrganizationMutation(currentOrgId ?? "");
  const deleteOrg = useDeleteOrganizationMutation();
  const updateRole = useUpdateMemberRoleMutation(currentOrgId ?? "");
  const removeMember = useRemoveMemberMutation(currentOrgId ?? "");
  const revokeInvite = useRevokeInviteMutation(currentOrgId ?? "");
  // Only an Owner / Admin may change someone's access (the server enforces it).
  const myRole = members?.find((m) => m.user.id === authUser?.id)?.role;
  const canManageAccess = myRole === "OWNER" || myRole === "ADMIN";

  // General form state
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgWebsite, setOrgWebsite] = useState<string | null>(null);
  const [orgIndustry, setOrgIndustry] = useState<string | null>(null);
  const [orgTimezone, setOrgTimezone] = useState<string | null>(null);
  const [orgCurrency, setOrgCurrency] = useState<string | null>(null);

  const displayName = orgName ?? org?.name ?? "";
  const displayWebsite = orgWebsite ?? org?.website ?? "";
  const displayIndustry = orgIndustry ?? org?.industry ?? "";
  const displayTimezone = orgTimezone ?? org?.timezone ?? "UTC";
  const displayCurrency = orgCurrency ?? org?.currency ?? "USD";

  function handleSaveGeneral() {
    updateOrg.mutate({
      name: orgName ?? org?.name,
      website: orgWebsite ?? org?.website ?? undefined,
      industry: orgIndustry ?? org?.industry ?? undefined,
    });
  }

  function handleSaveLocalization() {
    updateOrg.mutate({
      timezone: orgTimezone ?? org?.timezone,
      currency: orgCurrency ?? org?.currency,
    });
  }

  function handleDeleteOrg() {
    if (!currentOrgId) return;
    if (!window.confirm("Are you sure? This will permanently delete this workspace and all its data.")) return;
    deleteOrg.mutate(currentOrgId);
  }

  // Password form
  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const changePassword = useMutation({
    mutationFn: (data: PasswordForm) =>
      userService.changePassword({ currentPassword: data.currentPassword, newPassword: data.newPassword }),
    onSuccess: () => {
      toast.success("Password changed. All other sessions revoked.");
      passwordForm.reset();
    },
    onError: (error) => {
      if (isAxiosError(error)) {
        toast.error(error.response?.data?.message || "Failed to change password.");
      } else {
        toast.error("Something went wrong.");
      }
    },
  });

  // Delete account
  const deleteAccount = useMutation({
    mutationFn: () => userService.deleteAccount(),
    onSuccess: () => {
      toast.success("Account deleted.");
      logout();
      navigate("/auth/login");
    },
    onError: () => toast.error("Failed to delete account."),
  });

  return (
    <div className="settings-page space-y-6">
      <div className="space-y-2">
        {tab && <Link to="/settings" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-sm text-muted-foreground md:hidden"><ArrowLeft className="size-4" />Settings</Link>}
        <h1 className="text-[27px] font-semibold tracking-tight text-foreground md:text-xl md:font-bold"><span className="md:hidden">{tab ? visibleTabs.find((item) => item.id === activeTab)?.label ?? "Settings" : "Settings"}</span><span className="hidden md:inline">Settings</span></h1>
        <p className="text-sm leading-relaxed text-muted-foreground">Make Collabo work your way.</p>
      </div>

      {!tab && <div className="space-y-5 md:hidden">
        <div className="flex items-center gap-4 rounded-3xl bg-brand/35 p-5"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-card"><Building2 className="size-6 text-brand-strong" strokeWidth={1.7} /></span><div className="min-w-0"><p className="text-xs text-muted-foreground">Your workspace</p><p className="mt-1 truncate text-base font-semibold">{org?.name || "Workspace settings"}</p></div></div>
        {[
          { label: "Workspace", ids: ["general", "store-profile", "members", "billing", "developers"] },
          { label: "Commerce & conversations", ids: ["channels", "inbox", "products", "orders", "tax-gst", "invoices", "loyalty"] },
          { label: "Account", ids: ["security"] },
        ].map((group) => {
          const entries = visibleTabs.filter((item) => group.ids.includes(item.id));
          if (!entries.length) return null;
          return <section key={group.label}><h2 className="mb-2.5 px-1 text-xs font-medium text-muted-foreground">{group.label}</h2><div className="divide-y divide-border/60 overflow-hidden rounded-3xl bg-card px-4">{entries.map(({ id, label, icon: Icon }) => <Link key={id} to={`/settings/${id}`} className="flex min-h-16 items-center gap-3 py-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-sunken"><Icon className="size-[18px] text-brand-strong" strokeWidth={1.7} /></span><span className="text-sm font-medium">{label}</span><ChevronRight className="ml-auto size-4 text-muted-foreground" /></Link>)}</div></section>;
        })}
      </div>}

      <div className={cn("flex gap-6 items-start", !tab && "max-md:hidden")}>
        {/* Sidebar */}
        <aside className="hidden w-52 shrink-0 md:block">
          <div className="rounded-xl bg-white dark:bg-gray-900 p-2 shadow-sm ring-1 ring-border">
            {visibleTabs.map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                to={`/settings/${id}`}
                aria-current={activeTab === id ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors text-left",
                  activeTab === id
                    ? "bg-[#CEF17B] text-gray-900"
                    : "text-gray-500 dark:text-gray-400 hover:bg-[#f1f7fa] dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-100"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
                {activeTab === id && <ChevronRight className="ml-auto size-3.5" />}
              </Link>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-4">

          {/* ─── GENERAL ─── */}
          {activeTab === "general" && (
            <>
              <Section title="Organization" description="Basic information about your workspace.">
                {orgLoading ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
                    <Loader2 className="size-4 animate-spin" /> Loading…
                  </div>
                ) : (
                  <>
                    <div className="space-y-4 divide-y divide-border">
                      <Field label="Organization Name" hint="The name shown across your CRM." htmlFor="org-name">
                        <input
                          id="org-name"
                          value={displayName}
                          onChange={(e) => setOrgName(e.target.value)}
                          disabled={!canManageTeam}
                          className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </Field>
                      <div className="pt-4">
                        <Field label="Industry" hint="Your primary business vertical." htmlFor="org-industry">
                          <Select value={displayIndustry || undefined} onValueChange={setOrgIndustry} disabled={!canManageTeam}>
                            <SelectTrigger id="org-industry" aria-labelledby="org-industry-label" className="w-full h-9 border-input bg-transparent">
                              <SelectValue placeholder="Select industry" />
                            </SelectTrigger>
                            <SelectContent>
                              {INDUSTRIES.map((industry) => (
                                <SelectItem key={industry} value={industry}>{industry}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      <div className="pt-4">
                        <Field label="Website" hint="Your company's public website." htmlFor="org-website">
                          <input
                            id="org-website"
                            value={displayWebsite}
                            onChange={(e) => setOrgWebsite(e.target.value)}
                            placeholder="https://yourstore.com"
                            disabled={!canManageTeam}
                            className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </Field>
                      </div>
                      {org?.type === "ORGANIZATION" && (
                        <div className="pt-4">
                          <Field label="Workspace Type" hint="This workspace is a team organization.">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex rounded-full bg-[#CEF17B]/30 px-2.5 py-1 text-xs font-semibold text-[#084734]">
                                Organization
                              </span>
                              <button
                                onClick={() => setOrgSheetMode("create")}
                                className="inline-flex h-7 items-center gap-1 rounded-md border bg-white dark:bg-gray-900 px-2.5 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                              >
                                Create another organization
                                <ChevronRight className="size-3" />
                              </button>
                            </div>
                          </Field>
                        </div>
                      )}
                      {org?.type === "PERSONAL" && (
                        <div className="pt-4">
                          <Field label="Workspace Type" hint="This is your personal workspace.">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                                Personal
                              </span>
                              <button
                                onClick={() => setOrgSheetMode("default")}
                                className="inline-flex h-7 items-center gap-1 rounded-md border bg-white dark:bg-gray-900 px-2.5 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                              >
                                Set up as organization
                                <ChevronRight className="size-3" />
                              </button>
                            </div>
                          </Field>
                        </div>
                      )}
                    </div>
                    {canManageTeam ? (
                      <div className="mt-5 flex justify-end">
                        <button
                          onClick={handleSaveGeneral}
                          disabled={updateOrg.isPending}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors disabled:opacity-50"
                        >
                          {updateOrg.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                          Save Changes
                        </button>
                      </div>
                    ) : (
                      <p className="mt-5 text-xs text-muted-foreground">{OWNER_ADMIN_ONLY}</p>
                    )}
                  </>
                )}
              </Section>

              <Section title="Localization" description="Timezone, currency, and regional settings.">
                <div className="space-y-4 divide-y divide-border">
                  <Field label="Timezone" htmlFor="org-timezone">
                    <Select value={displayTimezone} onValueChange={setOrgTimezone} disabled={!canManageTeam}>
                      <SelectTrigger id="org-timezone" aria-labelledby="org-timezone-label" className="w-full h-9 border-input bg-transparent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="pt-4">
                    <Field label="Currency" htmlFor="org-currency">
                      <Select value={displayCurrency} onValueChange={setOrgCurrency} disabled={!canManageTeam}>
                        <SelectTrigger id="org-currency" aria-labelledby="org-currency-label" className="w-full h-9 border-input bg-transparent">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCIES.map((currency) => (
                            <SelectItem key={currency.value} value={currency.value}>{currency.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </div>
                {canManageTeam ? (
                  <div className="mt-5 flex justify-end">
                    <button
                      onClick={handleSaveLocalization}
                      disabled={updateOrg.isPending}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors disabled:opacity-50"
                    >
                      {updateOrg.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Save Changes
                    </button>
                  </div>
                ) : (
                  <p className="mt-5 text-xs text-muted-foreground">{OWNER_ADMIN_ONLY}</p>
                )}
              </Section>

              {/* Only the owner may delete the workspace. */}
              {memberRole === "OWNER" && (
                <div className="rounded-xl bg-white dark:bg-gray-900 p-6 shadow-sm ring-1 ring-red-100">
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                      <AlertTriangle className="size-4 text-red-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Danger Zone</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Permanently delete this workspace and all its data. This action cannot be undone.
                      </p>
                      <button
                        onClick={handleDeleteOrg}
                        disabled={deleteOrg.isPending}
                        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 px-4 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        {deleteOrg.isPending && <Loader2 className="size-3.5 animate-spin" />}
                        Delete Workspace
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ─── SECURITY ─── */}
          {activeTab === "security" && (
            <>
              <Section title="Change Password" description="Update your account password regularly.">
                <form onSubmit={passwordForm.handleSubmit((formData) => changePassword.mutate(formData))} className="space-y-3">
                  <Field label="Current Password" htmlFor="currentPassword">
                    <input
                      id="currentPassword"
                      type="password"
                      placeholder="••••••••"
                      aria-invalid={!!passwordForm.formState.errors.currentPassword}
                      aria-describedby={passwordForm.formState.errors.currentPassword ? "currentPassword-error" : undefined}
                      {...passwordForm.register("currentPassword")}
                      className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                    />
                    {passwordForm.formState.errors.currentPassword && (
                      <p id="currentPassword-error" className="mt-1 text-xs text-red-500">{passwordForm.formState.errors.currentPassword.message}</p>
                    )}
                  </Field>
                  <Field label="New Password" hint="Minimum 8 characters." htmlFor="newPassword">
                    <input
                      id="newPassword"
                      type="password"
                      placeholder="••••••••"
                      aria-invalid={!!passwordForm.formState.errors.newPassword}
                      aria-describedby={passwordForm.formState.errors.newPassword ? "newPassword-error" : undefined}
                      {...passwordForm.register("newPassword")}
                      className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                    />
                    {passwordForm.formState.errors.newPassword && (
                      <p id="newPassword-error" className="mt-1 text-xs text-red-500">{passwordForm.formState.errors.newPassword.message}</p>
                    )}
                  </Field>
                  <Field label="Confirm New Password" htmlFor="confirmPassword">
                    <input
                      id="confirmPassword"
                      type="password"
                      placeholder="••••••••"
                      aria-invalid={!!passwordForm.formState.errors.confirmPassword}
                      aria-describedby={passwordForm.formState.errors.confirmPassword ? "confirmPassword-error" : undefined}
                      {...passwordForm.register("confirmPassword")}
                      className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                    />
                    {passwordForm.formState.errors.confirmPassword && (
                      <p id="confirmPassword-error" className="mt-1 text-xs text-red-500">{passwordForm.formState.errors.confirmPassword.message}</p>
                    )}
                  </Field>
                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      disabled={changePassword.isPending}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors disabled:opacity-50"
                    >
                      {changePassword.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Update Password
                    </button>
                  </div>
                </form>
              </Section>

              {/* <Section title="Two-Factor Authentication" description="Add an extra layer of security.">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-[#CEF17B]/25">
                      <Smartphone className="size-5 text-[#084734]" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Authenticator App</p>
                      <p className="text-xs text-muted-foreground">
                        {authUser?.twoFactorEnabled ? "Two-factor is enabled." : "Use Google Authenticator or similar app."}
                      </p>
                    </div>
                  </div>
                  <button className="inline-flex h-8 items-center rounded-lg border border-input bg-white dark:bg-gray-900 px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
                    {authUser?.twoFactorEnabled ? "Disable 2FA" : "Enable 2FA"}
                  </button>
                </div>
              </Section> */}

              <div className="rounded-xl bg-white dark:bg-gray-900 p-6 shadow-sm ring-1 ring-red-100">
                <div className="flex items-start gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                    <AlertTriangle className="size-4 text-red-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Delete Account</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Permanently delete your account. This cannot be undone.
                    </p>
                    <button
                      onClick={() => {
                        if (window.confirm("Are you sure you want to delete your account? This cannot be undone.")) {
                          deleteAccount.mutate();
                        }
                      }}
                      disabled={deleteAccount.isPending}
                      className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 px-4 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      {deleteAccount.isPending && <Loader2 className="size-3.5 animate-spin" />}
                      Delete My Account
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ─── NOTIFICATIONS ─── */}
          {activeTab === "notifications" && (
            <Section title="Notification Preferences" description="Choose which events trigger email or push notifications.">
              <div className="divide-y divide-border">
                <NotifRow label="New Order" hint="When a new order is placed." email push />
                <NotifRow label="Order Status Changed" hint="When an order moves to a new status." email push={false} />
                <NotifRow label="New Customer" hint="When a new customer is added." email={false} push />
                <NotifRow label="Low Stock Alert" hint="When a product falls below threshold." email push />
                <NotifRow label="New Message" hint="When a customer sends a message." email push />
                <NotifRow label="Weekly Summary" hint="A weekly digest of your CRM activity." email push={false} />
                <NotifRow label="Team Updates" hint="When a team member joins or changes role." email={false} push={false} />
              </div>
              <div className="mt-5 flex justify-end">
                <button className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors">
                  <Check className="size-3.5" /> Save Preferences
                </button>
              </div>
            </Section>
          )}

          {/* ─── TEAM MEMBERS ─── */}
          {activeTab === "members" && (
            <>
              <Section title="Team Members" description="Manage who has access to your workspace.">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    {membersLoading ? "Loading…" : `${staffMembers.length} member${staffMembers.length !== 1 ? "s" : ""}`}
                  </p>
                  {canManageTeam && (
                    <button
                      onClick={() => setShowInvite(true)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] transition-colors"
                    >
                      <Plus className="size-3.5" /> Invite Member
                    </button>
                  )}
                </div>

                {showInvite && canManageTeam && currentOrgId && (
                  <div className="mb-4">
                    <InviteForm orgId={currentOrgId} onDone={() => setShowInvite(false)} />
                  </div>
                )}

                {membersLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
                    <Loader2 className="size-4 animate-spin" /> Loading members…
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Influencers are members too, but they are an outside
                        party with their own lifecycle and their own section
                        below. Listing them here would put them in the staff
                        role dropdown, where an admin could quietly demote one
                        into an AGENT with access to the whole organization. */}
                    {staffMembers?.map((member, index) => {
                      const initials = `${member.user.firstName[0]}${member.user.lastName[0]}`.toUpperCase();
                      const isOwner = member.role === "OWNER";
                      const isCurrentUser = member.user.id === authUser?.id;
                      const hasSectionAccess = isSectionScopedRole(member.role);

                      return (
                        <div key={member.id} className="space-y-2">
                        <div className="flex items-center gap-3 rounded-lg bg-[#f1f7fa] dark:bg-gray-800/60 px-4 py-3">
                          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold", AVATAR_COLORS[index % AVATAR_COLORS.length])}>
                            {initials}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                              {member.user.firstName} {member.user.lastName}
                              {isCurrentUser && <span className="ml-1.5 text-[10px] text-gray-400">(you)</span>}
                            </p>
                            <p className="text-caption text-muted-foreground">{member.user.email}</p>
                          </div>

                          {hasSectionAccess && canManageAccess && (
                            <button
                              type="button"
                              onClick={() => setAccessMemberId(accessMemberId === member.id ? null : member.id)}
                              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-[10px] font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              <Lock className="size-3" /> {sectionAccessLabel(member.permissions)}
                            </button>
                          )}

                          {isOwner ? (
                            <span className="shrink-0 rounded-full bg-[#CEF17B]/30 px-2 py-0.5 text-[10px] font-semibold text-[#084734]">
                              Owner
                            </span>
                          ) : !canManageTeam ? (
                            <span className="shrink-0 rounded-full bg-white dark:bg-gray-900 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300 ring-1 ring-border">
                              {roleLabel(member.role)}
                            </span>
                          ) : (
                            <Select
                              value={member.role}
                              onValueChange={(selectedRole) => {
                                // Vendor needs the vendor they supply first; the role
                                // shown stays as it is until that is saved.
                                if (selectedRole === "VENDOR") {
                                  setVendorMember(member);
                                  return;
                                }
                                updateRole.mutate(
                                  { memberId: member.id, data: { role: selectedRole as UserRole } },
                                  {
                                    // Moving someone down to Agent / Viewer leaves them with full
                                    // access until sections are picked — open the picker for it.
                                    onSuccess: () => {
                                      if (
                                        isSectionScopedRole(selectedRole as UserRole) &&
                                        sectionsInGrants(member.permissions ?? []).length === 0
                                      ) {
                                        setAccessMemberId(member.id);
                                      }
                                    },
                                  },
                                );
                              }}
                            >
                              <SelectTrigger
                                aria-label={`Role for ${member.user.firstName} ${member.user.lastName}`}
                                className="h-7 w-[100px] shrink-0 border-input bg-white dark:bg-gray-900 text-xs"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLE_OPTIONS.map((roleOption) => (
                                  <SelectItem key={roleOption.value} value={roleOption.value}>{roleOption.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}

                          {canManageTeam && !isOwner && !isCurrentUser && (
                            <button
                              onClick={() => {
                                if (window.confirm(`Remove ${member.user.firstName} from this workspace?`)) {
                                  removeMember.mutate(member.id);
                                }
                              }}
                              aria-label={`Remove ${member.user.firstName} ${member.user.lastName}`}
                              className="-m-1.5 shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </div>
                        {hasSectionAccess && accessMemberId === member.id && currentOrgId && (
                          <MemberAccessEditor
                            orgId={currentOrgId}
                            member={member}
                            onDone={() => setAccessMemberId(null)}
                          />
                        )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {vendorMember && canManageTeam && currentOrgId && (
                  <VendorRoleDialog orgId={currentOrgId} member={vendorMember} onClose={() => setVendorMember(null)} />
                )}
              </Section>

              {/* Pending invites */}
              {staffInvites.length > 0 && (
                <Section title="Pending Invitations" description="Invitations that haven't been accepted yet.">
                  <div className="space-y-2">
                    {staffInvites.map((invite) => (
                      <div key={invite.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#f1f7fa] dark:bg-gray-800/60 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex size-8 items-center justify-center rounded-full bg-orange-100 text-xs font-bold text-orange-700">
                            <Mail className="size-3.5" />
                          </div>
                          <div>
                            <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{invite.email}</p>
                            <p className="text-caption text-muted-foreground">
                              Invited as {invite.role.toLowerCase()}
                              {isSectionScopedRole(invite.role) && ` · ${sectionAccessLabel(invite.permissions)}`} · Expires {new Date(invite.expiresAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => revokeInvite.mutate(invite.id)}
                          className="text-xs font-medium text-red-500 hover:text-red-700 transition-colors"
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Influencers: external collaborators, invited and tracked here,
                  who connect their own Instagram from Settings -> Channels. */}
              {currentOrgId && platformOffered("INSTAGRAM") && (
                <InfluencersSection
                  orgId={currentOrgId}
                  canManage={canManageTeam}
                  isPersonalWorkspace={org?.type === "PERSONAL"}
                />
              )}
            </>
          )}

          {/* ─── BILLING ─── */}
          {activeTab === "billing" && org && (memberRole === "OWNER" || memberRole === "ADMIN") && <BillingTab orgId={org.id} />}
          {activeTab === "billing" && memberRole && memberRole !== "OWNER" && memberRole !== "ADMIN" && (
            <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm ring-1 ring-border">Only the workspace owner and admins can see billing and plans.</p>
          )}

          {/* ─── PRODUCT SETTINGS ─── */}
          {activeTab === "store-profile" && <StoreProfileTab />}

          {activeTab === "products" && <ProductSettingsTab />}

          {/* ─── ORDER SETTINGS ─── */}
          {activeTab === "orders" && <OrderSettingsTab />}

          {/* ── Channels ─────────────────────────────────────────── */}
          {activeTab === "channels" && <ChannelSettingsTab />}

          {activeTab === "inbox" && <InboxSettingsTab />}
          {activeTab === "developers" && canManageTeam && <DevelopersTab />}
          {activeTab === "developers" && memberRole && !canManageTeam && (
            <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm ring-1 ring-border">Only the workspace owner and admins can manage API keys and webhooks.</p>
          )}

          {/* ─── TAX & GST ─── */}
          {activeTab === "tax-gst" && org && (
            <TaxGstTab orgId={org.id} gstEnabled={org.gstEnabled ?? false} />
          )}

          {activeTab === "invoices" && <InvoiceSettingsTab />}

          {/* ─── LOYALTY TIERS ─── */}
          {activeTab === "loyalty" && org && (
            <LoyaltyTab org={org} />
          )}

          {/* ─── APPEARANCE ─── */}
          {activeTab === "appearance" && (
            <AppearanceTab />
          )}

        </div>
      </div>

      {/* Org-setup sheet — handles both "upgrade personal to org" and
          "create new org alongside" flows. Mode controls whether the choice
          step is shown or the form opens directly. */}
      {orgSheetMode !== null && org && (
        <UpgradeOrganizationDialog
          org={org}
          onClose={() => setOrgSheetMode(null)}
          initialPath={orgSheetMode === "create" ? "create" : undefined}
        />
      )}
    </div>
  );
}
