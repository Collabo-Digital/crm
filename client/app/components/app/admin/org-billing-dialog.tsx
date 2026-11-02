import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useSetOrgBilling } from "~/hooks/use-admin-queries";
import { formatDate } from "~/lib/format-date";
import type { AdminUserMembership } from "~/services/admin.service";
import type { BillingInterval, BillingPlan } from "~/types/api";

/** The stored plan ids, as the app names them. */
export const PLAN_NAME: Record<BillingPlan, string> = { BASIC: "Starter", GROWTH: "Growth", PRO: "Pro", SCALE: "Scale", ADVANCE: "Enterprise" };

const DAY_MS = 24 * 60 * 60 * 1000;
const field = "h-10 w-full rounded-lg border bg-background px-2 text-body";

/** A date input's value (the local day) for an ISO time. */
const toDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : "");
/** The end of that local day, as the trial's end. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();

const STANDING: Record<AdminUserMembership["billing"]["access"], string> = { trialing: "", active: "", grace: " · payment needed", expired: " · read-only" };

/** One workspace's billing in a line: plan, how it is paid, the trial, and whether it needs payment or is read-only. */
export function billingSummary(b: AdminUserMembership["billing"]): string {
    const paid = b.billingProvider === "MANUAL"
        ? "invoiced by the team"
        : b.subscriptionStatus
            ? `Razorpay, ${b.subscriptionStatus.toLowerCase()}`
            : "no subscription";
    const trial = b.trialEndsAt ? ` · trial ${new Date(b.trialEndsAt).getTime() > Date.now() ? "ends" : "ended"} ${formatDate(b.trialEndsAt)}` : "";
    return `${PLAN_NAME[b.billingPlan]}${b.billingInterval ? `, ${b.billingInterval.toLowerCase()}` : ""} · ${paid}${trial}${STANDING[b.access]}`;
}

/**
 * Super admin "Set plan / extend trial" for one workspace: Scale and
 * Enterprise deals (invoiced by the Collabo team) and longer trials. A
 * workspace paying through Razorpay keeps its subscription's plan; the server
 * says so if one is changed. Only what changed is sent.
 */
export function OrgBillingDialog({ userId, membership, onClose }: { userId: string; membership: AdminUserMembership; onClose: () => void }) {
    const { billing } = membership;
    const save = useSetOrgBilling(userId);
    const [plan, setPlan] = useState<BillingPlan>(billing.billingPlan);
    const [interval, setBillingInterval] = useState<BillingInterval>(billing.billingInterval ?? "YEARLY");
    const [manual, setManual] = useState(billing.billingProvider === "MANUAL");
    const [trialDay, setTrialDay] = useState(toDay(billing.trialEndsAt));

    const submit = () => {
        const body = {
            ...(plan !== billing.billingPlan ? { billingPlan: plan } : {}),
            ...(interval !== billing.billingInterval ? { billingInterval: interval } : {}),
            ...(manual !== (billing.billingProvider === "MANUAL") ? { manual } : {}),
            ...(trialDay !== toDay(billing.trialEndsAt) ? { trialEndsAt: trialDay ? endOfDay(trialDay) : null } : {}),
        };
        save.mutate({ orgId: membership.organizationId, body }, { onSuccess: onClose });
    };
    const extendBy = (days: number) => {
        const from = Math.max(Date.now(), billing.trialEndsAt ? new Date(billing.trialEndsAt).getTime() : 0);
        setTrialDay(toDay(new Date(from + days * DAY_MS).toISOString()));
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Set plan or extend trial</DialogTitle>
                    <DialogDescription>
                        {membership.orgName}: {billingSummary(billing)}. Each change is logged with your name.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                        <span className="font-medium">Plan</span>
                        <select className={field} value={plan} onChange={(e) => setPlan(e.target.value as BillingPlan)}>
                            {(Object.keys(PLAN_NAME) as BillingPlan[]).map((id) => (
                                <option key={id} value={id}>{PLAN_NAME[id]}</option>
                            ))}
                        </select>
                    </label>
                    <label className="space-y-1 text-sm">
                        <span className="font-medium">Paid</span>
                        <select className={field} value={interval} onChange={(e) => setBillingInterval(e.target.value as BillingInterval)}>
                            <option value="YEARLY">Yearly</option>
                            <option value="MONTHLY">Monthly</option>
                        </select>
                    </label>
                    <label className="flex items-start gap-2 text-sm sm:col-span-2">
                        <input type="checkbox" className="mt-1 size-4" checked={manual} onChange={(e) => setManual(e.target.checked)} />
                        <span>
                            <span className="font-medium">Invoiced by the Collabo team</span>
                            <span className="block text-caption text-muted-foreground">
                                For Scale and Enterprise deals paid by invoice and bank transfer. The workspace counts as paid, and its usage is not billed automatically.
                            </span>
                        </span>
                    </label>
                    <div className="space-y-1 text-sm sm:col-span-2">
                        <label htmlFor="trial-ends" className="font-medium">Trial ends</label>
                        <div className="flex flex-wrap items-center gap-2">
                            <input id="trial-ends" type="date" className={`${field} w-auto`} value={trialDay} onChange={(e) => setTrialDay(e.target.value)} />
                            <Button type="button" variant="outline" size="sm" onClick={() => extendBy(7)}>+7 days</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => extendBy(14)}>+14 days</Button>
                            {trialDay && <Button type="button" variant="ghost" size="sm" onClick={() => setTrialDay("")}>End trial now</Button>}
                        </div>
                        <p className="text-caption text-muted-foreground">
                            The trial lasts to the end of that day. Cleared, it ends now. Either way a grace period follows before the workspace turns read-only.
                        </p>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Cancel</Button>
                    <Button onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving..." : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
