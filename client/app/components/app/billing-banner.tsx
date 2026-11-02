import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock } from "lucide-react";

import { orgKeys } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { billingBanner } from "~/lib/plan-pricing";
import { STATUS_TONE_CLASSES, type StatusTone } from "~/lib/status-tone";
import { cn } from "~/lib/utils";
import { orgService } from "~/services/org.service";
import { useAuthStore } from "~/stores/auth.store";

const TONE: Record<"info" | "warning" | "danger", StatusTone> = { info: "info", warning: "attention", danger: "critical" };

/**
 * The workspace's trial and payment state, under the app bar: from day 10 of
 * the trial, through the grace period, and while read-only. Owners and
 * admins get a way to the plans. Nothing shows while enforcement is off.
 */
export function BillingBanner({ className }: { className?: string }) {
  const orgId = useAuthStore((s) => s.currentOrgId);
  const { role } = useCurrentRole();
  // Same query as useCurrentOrg, asked again now and then: a long-open tab
  // still learns when the trial ends.
  const { data: org } = useQuery({
    queryKey: orgKeys.detail(orgId ?? ""),
    queryFn: () => orgService.get(orgId!),
    enabled: !!orgId,
    refetchInterval: 15 * 60_000,
  });
  const banner = billingBanner(org?.billingAccess);
  if (!banner) return null;
  const Icon = banner.tone === "info" ? Clock : AlertTriangle;
  return (
    <div role="status" className={cn("w-full border-b border-border/60", STATUS_TONE_CLASSES[TONE[banner.tone]], className)}>
      <div className="mx-auto flex max-w-screen-xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm lg:px-6">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="font-medium">{banner.text}</span>
        {(role === "OWNER" || role === "ADMIN") && (
          <Link to="/settings/billing" className="font-semibold underline underline-offset-2">
            {role === "OWNER" ? "See plans" : "See billing"}
          </Link>
        )}
      </div>
    </div>
  );
}
