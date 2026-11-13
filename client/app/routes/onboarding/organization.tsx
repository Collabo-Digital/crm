import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { OrganizationForm } from "~/components/app/onboarding/organization-form";
import { QueryErrorState } from "~/components/app/query-error-state";
import { gstKeys } from "~/hooks/use-gst-queries";
import { useOnboardingWizard } from "~/hooks/use-onboarding";
import { useOrganization } from "~/hooks/use-org-queries";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import {
  EMPTY_ORGANIZATION_FORM,
  savedOrganizationValues,
  type OrganizationFormValues,
} from "~/lib/onboarding-organization";
import { detectTimezone } from "~/lib/org-options";
import { gstService } from "~/services/gst.service";

export function meta() {
  return [{ title: "Set up your organization | Collabo CRM" }];
}

/** Has the owner typed anything into this draft, beyond the defaults the form starts with? */
function hasAnswers(draft: Partial<OrganizationFormValues>): boolean {
  const { country: _country, timezone: _timezone, gstRegistered: _gstRegistered, ...typed } = draft;
  return Object.values(typed).some((value) => value !== "");
}

/**
 * Setup step 2. Decides what the form starts from, once:
 *
 * - no workspace yet → the browser draft
 * - workspace, step not saved yet → the draft if it has answers (a save that
 *   failed part-way), else what the server has
 * - step saved → what the server has
 *
 * "Once" matters: saving the step is what creates the workspace, and the form
 * must not start over under the owner when that happens.
 */
export default function OrganizationStepPage() {
  const { orgId, draft, completedSteps, onboarding } = useOnboardingWizard();
  const org = useOrganization(orgId);
  const settings = useOrganizationSettings(!!orgId);
  const gstins = useQuery({
    queryKey: gstKeys.gstins(),
    queryFn: () => gstService.listGstins(),
    enabled: !!orgId,
  });

  const fromDraft = (): { values: OrganizationFormValues; resumed: boolean } => ({
    values: { ...EMPTY_ORGANIZATION_FORM, timezone: detectTimezone(), ...draft.organization },
    resumed: hasAnswers(draft.organization),
  });
  const [start, setStart] = useState(() => (orgId ? null : fromDraft()));

  const stepDone = completedSteps.has("organization");
  const profile = settings.data?.storeProfileSettings;
  useEffect(() => {
    if (start || !onboarding || !org.data || !profile || !gstins.data) return;
    if (!stepDone && hasAnswers(draft.organization)) {
      setStart(fromDraft());
      return;
    }
    const saved = savedOrganizationValues(org.data, profile, gstins.data);
    // A workspace that has never been through this step still has the server's default zone.
    setStart({ values: stepDone ? saved : { ...saved, timezone: detectTimezone() }, resumed: false });
    // `fromDraft` reads the draft, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, onboarding, org.data, profile, gstins.data, stepDone, draft.organization]);

  if (!start) {
    if (org.isError || settings.isError || gstins.isError) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-8">
          <QueryErrorState
            resource="your organization details"
            onRetry={() => {
              void org.refetch();
              void settings.refetch();
              void gstins.refetch();
            }}
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-64 items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your details" />
      </div>
    );
  }

  return <OrganizationForm initial={start.values} resumed={start.resumed} savedLogoUrl={profile?.logoUrl ?? ""} />;
}
