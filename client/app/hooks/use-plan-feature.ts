import { useQuery } from "@tanstack/react-query";

import { orgKeys } from "~/hooks/use-org-queries";
import { gateLocked } from "~/lib/plan-pricing";
import { orgService } from "~/services/org.service";
import { useAuthStore } from "~/stores/auth.store";
import type { PlanGate } from "~/types/api";

/**
 * Whether the workspace's plan has a gated feature (the packing assistant,
 * messaging analytics, API keys, store-limited staff). Locked only when the
 * server says so: every feature is open while plans are not enforced.
 * `pending` while the workspace is loading, so a gated page waits rather
 * than flashing up before its lock.
 */
export function usePlanFeature(gate: PlanGate | null): { locked: boolean; pending: boolean } {
  const orgId = useAuthStore((s) => s.currentOrgId);
  const { data: org, isPending } = useQuery({ queryKey: orgKeys.detail(orgId ?? ""), queryFn: () => orgService.get(orgId!), enabled: !!orgId && !!gate });
  return { locked: !!gate && gateLocked(org, gate), pending: !!gate && !!orgId && isPending };
}
