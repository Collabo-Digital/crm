import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";

import { channelKeys } from "~/hooks/use-channel-queries";
import { gstKeys } from "~/hooks/use-gst-queries";
import { orgKeys, useOrganization, useOrgInvites } from "~/hooks/use-org-queries";
import { settingsKeys, useOrganizationSettings } from "~/hooks/use-settings-queries";
import { activeChannelsFor, CHANNEL_PROVIDERS } from "~/lib/channel-providers";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { readOnboardingDraft, updateOnboardingDraft, useOnboardingDraft } from "~/lib/onboarding-draft";
import {
  gstinState,
  savedOrganizationValues,
  websiteUrl,
  type OrganizationFormValues,
} from "~/lib/onboarding-organization";
import {
  nextOnboardingStep,
  onboardingStepFromPath,
  onboardingStepPath,
  onboardingSteps,
  previousOnboardingStep,
  type OnboardingStepId,
} from "~/lib/onboarding-steps";
import { INDIA } from "~/lib/org-options";
import { queryClient as appQueryClient } from "~/lib/query-client";
import { getLandingPath } from "~/lib/sections";
import { SessionChangedError } from "~/lib/session-stamp";
import { authService } from "~/services/auth.service";
import { channelService } from "~/services/channel.service";
import { gstService } from "~/services/gst.service";
import { orgService } from "~/services/org.service";
import { organizationSettingsService } from "~/services/organization-settings.service";
import { useAuthStore } from "~/stores/auth.store";
import type {
  CreatePersonalRequest,
  OnboardingAudience,
  OnboardingServerStep,
  OrganizationMembership,
  OrgResponse,
  UpdateOnboardingRequest,
} from "~/types/api";

/** The workspace's setup progress. Only its owner may read it, so pass null for anyone else. */
export function useOnboarding(orgId: string | null) {
  return useQuery({
    queryKey: orgKeys.onboarding(orgId ?? ""),
    queryFn: () => orgService.getOnboarding(orgId!),
    enabled: !!orgId,
  });
}

/** One wizard save. The server's answer replaces the cached progress, so the sidebar follows at once. */
export function useUpdateOnboardingMutation(orgId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: UpdateOnboardingRequest) => orgService.updateOnboarding(orgId!, update),
    onSuccess: (onboarding) => {
      if (orgId) queryClient.setQueryData(orgKeys.onboarding(orgId), onboarding);
    },
  });
}

/**
 * Everything the wizard's pages share: whose setup this is, which steps it
 * has, which one is on screen and how far it has got.
 *
 * `orgId` is null until the Organization step creates the workspace; until
 * then the browser draft is the only state there is. After that the server is
 * the source: `audience` follows the workspace type, so upgrading a "Just me"
 * workspace adds the team steps by itself.
 */
export function useOnboardingWizard() {
  const userId = useAuthStore((state) => state.user?.id) ?? "";
  const organizations = useAuthStore((state) => state.organizations);
  const currentOrgId = useAuthStore((state) => state.currentOrgId);
  const draft = useOnboardingDraft();

  const membership = organizations.find((member) => member.organization.id === currentOrgId);
  // The owner runs setup; the server refuses everyone else.
  const orgId = membership?.role === "OWNER" ? membership.organization.id : null;
  const { data: onboarding, isPending, isError } = useOnboarding(orgId);

  const storedAudience: OnboardingAudience | null = membership
    ? membership.organization.type === "PERSONAL"
      ? "solo"
      : "team"
    : null;
  const audience = onboarding?.audience ?? storedAudience ?? draft.audience;

  const steps = onboardingSteps(audience);
  const { pathname } = useLocation();
  // -1 on the wizard's other pages (the resume redirect, the completion page).
  const stepIndex = steps.findIndex((step) => step.id === onboardingStepFromPath(pathname));

  // Welcome has nothing to save: it is done once the owner has moved past it.
  const completedSteps = new Set<OnboardingStepId>(onboarding?.progress.completedSteps);
  if (orgId || stepIndex > 0) completedSteps.add("welcome");

  return {
    userId,
    orgId,
    orgName: membership?.organization.name ?? null,
    draft,
    audience,
    steps,
    stepIndex,
    completedSteps,
    onboarding,
    isLoading: !!orgId && isPending,
    isError: !!orgId && isError,
  };
}

/**
 * Remember the step to reopen, on the way out of the wizard, with any answers
 * not saved yet. Best effort: leaving is never held up by this failing, the
 * resume point is just older.
 */
export async function recordOnboardingStep(
  orgId: string,
  step: OnboardingServerStep,
  answers?: Pick<UpdateOnboardingRequest, "businessProfile">,
) {
  try {
    const onboarding = await orgService.updateOnboarding(orgId, { ...answers, currentStep: step });
    appQueryClient.setQueryData(orgKeys.onboarding(orgId), onboarding);
  } catch {
    // Nothing to do: the wizard reopens at the last step it did record.
  }
}

/**
 * What every step after Organization does the same way: mark itself done and
 * move to the next step, or leave for the app remembering where to resume.
 */
export function useWizardStep(step: OnboardingServerStep) {
  const navigate = useNavigate();
  const { orgId, audience, completedSteps } = useOnboardingWizard();
  const update = useUpdateOnboardingMutation(orgId);
  const [leaving, setLeaving] = useState(false);
  const next = nextOnboardingStep(step, audience);
  const previous = previousOnboardingStep(step, audience);
  const isDone = completedSteps.has(step);

  /** Marks the step done and opens the next one. False, after saying why, when the server refuses. */
  async function complete(answers?: Pick<UpdateOnboardingRequest, "businessProfile">): Promise<boolean> {
    try {
      await update.mutateAsync({
        ...answers,
        completeStep: step,
        // Going back to edit a finished step must not move the resume point back with it.
        ...(!isDone && next && next !== "welcome" && { currentStep: next }),
      });
    } catch (error) {
      handleMutationError(error, "Your progress couldn't be saved. Try again.");
      return false;
    }
    if (next) navigate(onboardingStepPath(next));
    return true;
  }

  /** To the app. The dashboard's setup card reopens the wizard on this step. */
  async function exit(answers?: Pick<UpdateOnboardingRequest, "businessProfile">) {
    setLeaving(true);
    if (orgId) await recordOnboardingStep(orgId, step, answers);
    navigate(getLandingPath());
  }

  return {
    complete,
    exit,
    isDone,
    isCompleting: update.isPending,
    isLeaving: leaving,
    previousPath: previous ? onboardingStepPath(previous) : null,
  };
}

// ─── Saving the Organization step ───────────────────────────────────────────

/** Which part of the Organization save failed. Everything before it is already saved. */
export type OrganizationSavePart = "workspace" | "details" | "contact" | "gst" | "progress";

export class OrganizationSaveError extends Error {
  readonly part: OrganizationSavePart;

  constructor(part: OrganizationSavePart, cause: unknown) {
    super(`The organization ${part} did not save.`, { cause });
    this.name = "OrganizationSaveError";
    this.part = part;
  }
}

async function savePart<T>(part: OrganizationSavePart, save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    // The session changed under the save: that message is the one to show.
    if (error instanceof SessionChangedError) throw error;
    throw new OrganizationSaveError(part, error);
  }
}

function toMembership(org: OrgResponse): OrganizationMembership {
  return {
    id: crypto.randomUUID(),
    organizationId: org.id,
    role: org.role,
    isActive: true,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      type: org.type,
      logo: org.logo,
      timezone: org.timezone,
      currency: org.currency,
      industry: org.industry,
      website: org.website,
      billingPlan: org.billingPlan,
      billingInterval: org.billingInterval,
      onboardingStatus: org.onboardingStatus,
      createdAt: org.createdAt,
      updatedAt: org.createdAt,
    },
  };
}

/** Keep the session's copy of the workspace (the switcher's name, its type) in step with a save. */
function storeOrganization(org: OrgResponse) {
  useAuthStore.setState((state) => ({
    organizations: state.organizations.map((member) =>
      member.organization.id === org.id
        ? {
            ...member,
            organization: {
              ...member.organization,
              name: org.name,
              type: org.type,
              timezone: org.timezone,
              currency: org.currency,
              industry: org.industry,
              website: org.website,
            },
          }
        : member,
    ),
  }));
}

/** A workspace this user already started setting up: the draft's own, else any they own that is still in setup. */
async function findUnfinishedWorkspace(draftOrgId: string | null): Promise<OrgResponse | null> {
  const inSetup = (await orgService.list()).filter(
    (org) => org.role === "OWNER" && org.onboardingStatus === "IN_PROGRESS",
  );
  return inSetup.find((org) => org.id === draftOrgId) ?? inSetup[0] ?? null;
}

/**
 * The workspace this wizard saves into, created on the first save only.
 *
 * Safe to run again after any failure: an owner already inside a workspace
 * keeps it, and otherwise the server is asked for one still in setup before a
 * new one is created. That covers a create whose response was lost, a session
 * switch that failed, and a wizard reopened on another device.
 */
async function ensureWorkspace(userId: string, name: string, audience: OnboardingAudience): Promise<string> {
  const { organizations, currentOrgId, pendingPlan, pendingBillingInterval } = useAuthStore.getState();
  if (organizations.length > 0 && currentOrgId) return currentOrgId;

  const billing: CreatePersonalRequest = {
    billingPlan: pendingPlan ?? "BASIC",
    billingInterval: pendingBillingInterval ?? "MONTHLY",
  };
  const org =
    (await findUnfinishedWorkspace(readOnboardingDraft(userId).orgId)) ??
    (audience === "solo" ? await orgService.createPersonal(billing) : await orgService.create({ name, ...billing }));
  updateOnboardingDraft(userId, { orgId: org.id });

  // The sign-up token names no workspace, and the settings and GST routes
  // read the workspace from the token.
  const session = await authService.switchOrg({ orgId: org.id });
  // One write, so nothing ever sees the new token beside the old workspace.
  useAuthStore.setState({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    currentOrgId: org.id,
    organizations: [toMembership(org)],
    pendingPlan: null,
    pendingBillingInterval: null,
  });
  return org.id;
}

/** The workspace's GSTIN: the one already on file is corrected, otherwise it is added as the default. */
async function saveGstin(values: OrganizationFormValues) {
  const gstin = values.gstin.trim().toUpperCase();
  const registration = {
    gstin,
    legalName: values.legalName.trim(),
    stateCode: gstin.slice(0, 2),
    stateName: gstinState(gstin)?.name ?? values.state.trim(),
    // A tax invoice must carry the supplier's address.
    address: {
      address1: values.street.trim(),
      city: values.city.trim(),
      province: values.state.trim(),
      zip: values.pin.trim(),
    },
  };
  const onFile = await gstService.listGstins();
  const existing = onFile.find((entry) => entry.gstin === gstin) ?? onFile.find((entry) => entry.isDefault);
  if (existing) await gstService.updateGstin(existing.id, registration);
  else await gstService.createGstin({ ...registration, isDefault: true });
}

interface SaveOrganizationInput {
  values: OrganizationFormValues;
  audience: OnboardingAudience;
  /** A logo picked before the workspace existed. Uploaded last; its failure never blocks the step. */
  logo: File | null;
  /** False when the step was already complete: an edit must not move the resume point back. */
  advance: boolean;
}

/**
 * Saves the Organization step: creates the workspace on the first save, then
 * writes its details, contact and address, GSTIN and logo, and marks the step
 * complete. Each part is its own request, and every one of them can be sent
 * again, so a failure part-way leaves the earlier parts saved and a retry
 * picks up from there. Throws `OrganizationSaveError` naming the part.
 */
export function useSaveOrganizationStep() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ values, audience, logo, advance }: SaveOrganizationInput) => {
      const userId = useAuthStore.getState().user?.id ?? "";
      const name = values.name.trim();
      const website = websiteUrl(values.website);

      const orgId = await savePart("workspace", () => ensureWorkspace(userId, name, audience));

      await savePart("details", async () => {
        const saved = await orgService.update(orgId, {
          name,
          industry: values.industry,
          timezone: values.timezone,
          gstEnabled: values.gstRegistered,
          // The server takes a URL or nothing here; a cleared website is cleared on the store profile below.
          ...(website && { website }),
          ...(values.country === INDIA && { currency: "INR" }),
        });
        // A workspace found on the server may predate the "My team" choice.
        const org =
          audience === "team" && saved.type === "PERSONAL"
            ? await orgService.upgradeToOrganization(orgId, { name })
            : saved;
        storeOrganization(org);
      });

      await savePart("contact", () =>
        organizationSettingsService.updateStoreProfileSettings({
          supportEmail: values.email.trim(),
          supportPhone: values.phone,
          country: values.country,
          province: values.state.trim(),
          city: values.city.trim(),
          zip: values.pin.trim(),
          address1: values.street.trim(),
          website,
        }),
      );

      if (values.gstRegistered) await savePart("gst", () => saveGstin(values));

      let logoFailed = false;
      if (logo) {
        try {
          await organizationSettingsService.uploadLogo(logo);
        } catch (error) {
          if (error instanceof SessionChangedError) throw error;
          logoFailed = true;
        }
      }

      const onboarding = await savePart("progress", () =>
        orgService.updateOnboarding(orgId, {
          completeStep: "organization",
          ...(advance && { currentStep: "business" as const }),
        }),
      );

      return { userId, orgId, onboarding, logoFailed };
    },
    onSuccess: ({ userId, orgId, onboarding }) => {
      queryClient.setQueryData(orgKeys.onboarding(orgId), onboarding);
      // The server holds the step now; the browser copy would only go stale.
      updateOnboardingDraft(userId, { organization: {} });
    },
    // Also after a failure: the parts before it did save.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      void queryClient.invalidateQueries({ queryKey: gstKeys.gstins() });
    },
  });
}

/**
 * Welcome, after the workspace exists: "Just me" changed to "My team". The
 * workspace is upgraded in place, which adds the channel and team steps. The
 * promise settles once the wizard's progress has been re-read, so the step
 * list is already the team one when the caller moves on.
 */
export function useUpgradeWorkspaceToTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orgId, name }: { orgId: string; name: string }) => orgService.upgradeToOrganization(orgId, { name }),
    onSuccess: (org) => {
      storeOrganization(org);
      return queryClient.invalidateQueries({ queryKey: orgKeys.all });
    },
    onError: (error) => handleMutationError(error, "The workspace couldn't be changed to a team workspace."),
  });
}

// ─── Review and completion ────────────────────────────────────────────────────

/**
 * What setup has collected, read back from the server for the Review step and
 * the completion page. Channels and invites are read for team workspaces
 * only: a "Just me" workspace has neither.
 */
export function useSetupSummary() {
  const { orgId, audience } = useOnboardingWizard();
  const isTeam = audience === "team";
  const org = useOrganization(orgId);
  const settings = useOrganizationSettings(!!orgId);
  const gstins = useQuery({
    queryKey: gstKeys.gstins(),
    queryFn: () => gstService.listGstins(),
    enabled: !!orgId,
  });
  const channels = useQuery({
    queryKey: channelKeys.list(),
    queryFn: () => channelService.list(),
    enabled: !!orgId && isTeam,
  });
  const invites = useOrgInvites(orgId, isTeam);
  const queries = isTeam ? [org, settings, gstins, channels, invites] : [org, settings, gstins];

  const profile = settings.data?.storeProfileSettings;
  return {
    isTeam,
    organization: org.data && profile && gstins.data ? savedOrganizationValues(org.data, profile, gstins.data) : null,
    /** Each channel the workspace can connect, with where it stands. */
    providers: CHANNEL_PROVIDERS.map((provider) => {
      const accounts = activeChannelsFor(provider, channels.data);
      const state = accounts.some((channel) => channel.connectionState !== "CONNECTED")
        ? ("attention" as const)
        : accounts.length > 0
          ? ("connected" as const)
          : ("none" as const);
      return { platform: provider.platform, label: provider.label, state };
    }),
    invited: (invites.data ?? []).filter((invite) => invite.status === "PENDING"),
    isLoading: queries.some((query) => query.isPending),
    isError: queries.some((query) => query.isError),
    refetch: () => queries.forEach((query) => void query.refetch()),
  };
}
