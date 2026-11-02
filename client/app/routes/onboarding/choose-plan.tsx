import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Rocket } from "lucide-react";
import { toast } from "sonner";

import { useAuthStore } from "~/stores/auth.store";
import { loadScript } from "~/lib/load-script";
import { billingService } from "~/services/billing.service";
import { useStartOnboardingCheckoutMutation } from "~/hooks/use-billing-mutations";
import { useBillingPlans } from "~/hooks/use-billing";
import { CurrencyToggle, EVERY_PLAN_NOTE, PlanCards } from "~/components/billing/plan-cards";
import { SubscribePicker } from "~/components/billing/subscribe-picker";
import type { BillingCurrency, BillingInterval, BillingPlan } from "~/types/api";

const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

export function meta() {
  return [{ title: "Choose Your Plan | Collabo CRM" }];
}

/**
 * Onboarding step 1, shown only while trials and the payment step are on
 * (BILLING_ENFORCEMENT; see OnboardingGuard): the plans, each with "Book a
 * demo", and the free trial first. A brand that has already agreed a plan
 * with us can pay for it here.
 *
 * Paying:
 *   1. The plan and interval are picked under "Already spoken to us?".
 *   2. POST /billing/onboarding-checkout creates a Razorpay Subscription,
 *      kept as pending on the User.
 *   3. Razorpay Checkout.js opens on it. Its webhook flips the subscription
 *      to ACTIVE; we poll GET /billing/pending-status until we see it, then
 *      go on to /onboarding/account-type.
 *   4. The org-create transaction copies the paid subscription onto the new
 *      Organization. Without one the workspace starts on the free trial.
 */
export default function ChoosePlanPage() {
  const navigate = useNavigate();
  const setPendingPlan = useAuthStore((state) => state.setPendingPlan);
  const user = useAuthStore((state) => state.user);

  const [scriptReady, setScriptReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currency, setCurrency] = useState<BillingCurrency>("INR");
  const [paying, setPaying] = useState(false);
  const startCheckout = useStartOnboardingCheckoutMutation();
  const { data: catalog, isError: catalogFailed } = useBillingPlans();
  const pollAbortRef = useRef<AbortController | null>(null);

  // Load Razorpay Checkout.js once on mount.
  useEffect(() => {
    loadScript(RAZORPAY_SCRIPT_URL)
      .then(() => setScriptReady(true))
      .catch(() => toast.error("Could not load payment SDK. Please refresh."));
    return () => pollAbortRef.current?.abort();
  }, []);

  /**
   * Polls /billing/pending-status until status flips to ACTIVE/AUTHENTICATED
   * (the webhook has confirmed the payment). Times out after 30s with a
   * "still verifying" message.
   */
  async function pollUntilActive(plan: BillingPlan, interval: BillingInterval): Promise<void> {
    pollAbortRef.current?.abort();
    const ac = new AbortController();
    pollAbortRef.current = ac;

    const start = Date.now();
    while (!ac.signal.aborted && Date.now() - start < POLL_TIMEOUT_MS) {
      try {
        const status = await billingService.getPendingStatus();
        if (status.status === "ACTIVE" || status.status === "AUTHENTICATED") {
          setPendingPlan(plan, interval);
          toast.success("Payment successful!");
          navigate("/onboarding/account-type");
          return;
        }
      } catch {
        // Transient error — keep polling.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!ac.signal.aborted) {
      toast.warning("Payment is still being verified. We will email you once it is confirmed.");
      setIsProcessing(false);
    }
  }

  async function pay(plan: BillingPlan, interval: BillingInterval) {
    if (!scriptReady) {
      toast.error("Payment SDK still loading, please retry in a moment.");
      return;
    }
    setIsProcessing(true);

    try {
      const checkout = await startCheckout.mutateAsync({ billingPlan: plan, billingInterval: interval, currency });
      if (!checkout.razorpayKeyId) {
        toast.error("Billing is not configured. Contact support.");
        setIsProcessing(false);
        return;
      }
      const planConfig = catalog?.plans.find((p) => p.id === plan);
      const rzp = new window.Razorpay({
        key: checkout.razorpayKeyId,
        subscription_id: checkout.subscriptionId,
        name: "Collabo CRM",
        description: `${planConfig?.name} plan, paid ${interval === "YEARLY" ? "yearly" : "monthly"}`,
        prefill: {
          name: `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim(),
          email: user?.email ?? "",
        },
        theme: { color: "#CEF17B" },
        handler: () => {
          // Razorpay says success — but the webhook is the ground truth.
          // Poll until the server confirms.
          void pollUntilActive(plan, interval);
        },
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            toast.info("Payment cancelled. You can start the free trial instead.");
          },
        },
      });
      rzp.open();
    } catch {
      // useStartOnboardingCheckoutMutation already toasted the error.
      setIsProcessing(false);
    }
  }

  return (
    <div>
      {/* Step indicator — 4 dots, first active */}
      <div className="mb-8 flex items-center justify-center gap-2">
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-[#CEF17B]" />
          <div className="h-px w-6 bg-gray-200" />
          <div className="size-2 rounded-full bg-gray-200" />
          <div className="h-px w-6 bg-gray-200" />
          <div className="size-2 rounded-full bg-gray-200" />
          <div className="h-px w-6 bg-gray-200" />
          <div className="size-2 rounded-full bg-gray-200" />
        </div>
        <span className="ml-2 text-xs text-gray-400">Step 1 of 4</span>
      </div>

      {/* Heading */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <Rocket className="size-5 text-[#084734]" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Choose your plan</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          {catalog?.trialDays
            ? `Try Collabo free for ${catalog.trialDays} days, no card needed. Book a demo and we'll set it up with you.`
            : "Book a demo and we'll set it up with you."}
        </p>
      </div>

      <div className="space-y-6">
        <div className="flex justify-center">
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </div>

        {catalog ? (
          <PlanCards catalog={catalog} currency={currency} />
        ) : (
          <p className="py-10 text-center text-sm text-gray-500">
            {catalogFailed ? "The plans could not be loaded. Refresh to try again." : "Loading plans…"}
          </p>
        )}

        <p className="text-center text-xs leading-relaxed text-gray-500">{EVERY_PLAN_NOTE}</p>

        {catalog?.trialDays && (
          <button
            type="button"
            onClick={() => navigate("/onboarding/account-type")}
            disabled={isProcessing}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:opacity-60"
          >
            Start my {catalog.trialDays}-day free trial <ArrowRight className="size-4" />
          </button>
        )}

        {catalog && (
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            {paying ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-gray-900">Already spoken to us? Pay now</p>
                <SubscribePicker catalog={catalog} currency={currency} busy={isProcessing || !scriptReady} onPay={(plan, interval) => void pay(plan, interval)} />
              </div>
            ) : (
              <button type="button" onClick={() => setPaying(true)} className="min-h-10 text-sm font-semibold text-gray-900 underline underline-offset-2">
                Already spoken to us? Pay now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
