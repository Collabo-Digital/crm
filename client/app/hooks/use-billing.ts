import { useQuery } from "@tanstack/react-query";
import { billingService } from "~/services/billing.service";

export const billingKeys = {
  all: ["billing"] as const,
  plans: () => [...billingKeys.all, "plans"] as const,
  usage: (orgId: string) => [...billingKeys.all, "usage", orgId] as const,
};

/** The price list. It changes with a deploy, not while the page is open. */
export function useBillingPlans() {
  return useQuery({ queryKey: billingKeys.plans(), queryFn: billingService.getPlans, staleTime: 30 * 60_000 });
}

/** The organization's plan, this month's usage and its usage bills (owners and admins). */
export function useBillingUsage(orgId: string | null, enabled = true) {
  return useQuery({ queryKey: billingKeys.usage(orgId ?? ""), queryFn: billingService.getUsage, enabled: !!orgId && enabled });
}
