import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  Loader2,
  Rocket,
} from "lucide-react";
import { toast } from "sonner";

import { useAuthStore } from "~/stores/auth.store";
import { loadScript } from "~/lib/load-script";
import { billingService } from "~/services/billing.service";
import { useStartOnboardingCheckoutMutation } from "~/hooks/use-billing-mutations";
import { useBillingPlans } from "~/hooks/use-billing";
import { CurrencyToggle, PlanCards, PRICING_NOTE } from "~/components/billing/plan-cards";
import {
  choosePlanSchema,
  type ChoosePlanFormValues,
} from "~/lib/schemas/onboarding.schemas";

const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

export function meta() {
  return [{ title: "Choose Your Plan | Collabo CRM" }];
}

/**
 * Onboarding step 1: pricing plan selection + Razorpay checkout.
 *
 * Flow:
 *   1. User picks a plan + interval.
 *   2. We call POST /billing/onboarding-checkout — server creates a Razorpay
 *      Subscription and stores it as pending on the User.
 *   3. We open Razorpay Checkout.js modal with the subscription_id.
 *   4. After payment, Razorpay's webhook flips the subscription to ACTIVE.
 *      We poll GET /billing/pending-status until we see ACTIVE, then advance
 *      to /onboarding/account-type.
 *   5. The org-create transaction copies the now-ACTIVE subscription onto the
 *      new Organization (server-side hard gate).
 */
export default function ChoosePlanPage() {
  const navigate = useNavigate();
  const setPendingPlan = useAuthStore((state) => state.setPendingPlan);
  const pendingPlan = useAuthStore((state) => state.pendingPlan);
  const pendingBillingInterval = useAuthStore(
    (state) => state.pendingBillingInterval,
  );
  const user = useAuthStore((state) => state.user);

  const [scriptReady, setScriptReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
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

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { isValid },
  } = useForm<ChoosePlanFormValues>({
    resolver: zodResolver(choosePlanSchema),
    mode: "onChange",
    defaultValues: {
      // Enterprise is set up with the Collabo team, never bought here.
      billingPlan: pendingPlan && pendingPlan !== "ADVANCE" ? pendingPlan : undefined,
      // Plans are billed monthly: usage over a plan is billed each month.
      billingInterval: pendingBillingInterval ?? "MONTHLY",
      currency: "INR",
    },
  });

  const selectedPlan = watch("billingPlan");
  const currency = watch("currency");

  /**
   * Polls /billing/pending-status until status flips to ACTIVE/AUTHENTICATED
   * (the webhook has confirmed the payment). Times out after 30s with a
   * "still verifying" message.
   */
  async function pollUntilActive(plan: ChoosePlanFormValues): Promise<void> {
    pollAbortRef.current?.abort();
    const ac = new AbortController();
    pollAbortRef.current = ac;

    const start = Date.now();
    while (!ac.signal.aborted && Date.now() - start < POLL_TIMEOUT_MS) {
      try {
        const status = await billingService.getPendingStatus();
        if (
          status.status === "ACTIVE" ||
          status.status === "AUTHENTICATED"
        ) {
          setPendingPlan(plan.billingPlan, plan.billingInterval);
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
      toast.warning(
        "Payment is still being verified. We will email you once it is confirmed.",
      );
      setIsProcessing(false);
    }
  }

  async function onSubmit(values: ChoosePlanFormValues) {
    if (!scriptReady) {
      toast.error("Payment SDK still loading, please retry in a moment.");
      return;
    }
    setIsProcessing(true);

    try {
      const checkout = await startCheckout.mutateAsync(values);
      if (!checkout.razorpayKeyId) {
        toast.error("Billing is not configured. Contact support.");
        setIsProcessing(false);
        return;
      }

      const planConfig = catalog?.plans.find(
        (p) => p.id === values.billingPlan,
      );

      const rzp = new window.Razorpay({
        key: checkout.razorpayKeyId,
        subscription_id: checkout.subscriptionId,
        name: "Collabo CRM",
        description: `${planConfig?.name} plan — ${values.billingInterval.toLowerCase()}`,
        prefill: {
          name: `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim(),
          email: user?.email ?? "",
        },
        theme: { color: "#CEF17B" },
        handler: () => {
          // Razorpay says success — but the webhook is the ground truth.
          // Poll until the server confirms.
          void pollUntilActive(values);
        },
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            toast.info("Payment cancelled. Pick a plan to continue.");
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
          Pick a plan and complete payment to continue. Cancel anytime from
          settings.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="flex justify-center">
          <Controller
            control={control}
            name="currency"
            render={({ field }) => (
              <CurrencyToggle
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                  // A plan that cannot be bought in the new currency is unpicked.
                  if (selectedPlan && !(catalog?.checkout[selectedPlan] ?? []).includes(next)) {
                    setValue("billingPlan", undefined as never, { shouldValidate: true });
                  }
                }}
              />
            )}
          />
        </div>

        {catalog ? (
          <Controller
            control={control}
            name="billingPlan"
            render={({ field }) => (
              <PlanCards
                catalog={catalog}
                currency={currency}
                selected={field.value}
                onSelect={field.onChange}
              />
            )}
          />
        ) : (
          <p className="py-10 text-center text-sm text-gray-500">
            {catalogFailed ? "The plans could not be loaded. Refresh to try again." : "Loading plans…"}
          </p>
        )}

        <p className="text-center text-xs leading-relaxed text-gray-500">{PRICING_NOTE}</p>

        {/* Submit */}
        <button
          type="submit"
          disabled={!isValid || isProcessing || !scriptReady}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isProcessing ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Processing payment…
            </>
          ) : (
            <>
              Continue to payment <ArrowRight className="size-4" />
            </>
          )}
        </button>

        {!selectedPlan && (
          <p className="text-center text-xs text-gray-400">
            Select a plan to continue.
          </p>
        )}
      </form>
    </div>
  );
}
