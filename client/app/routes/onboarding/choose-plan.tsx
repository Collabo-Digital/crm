import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  Check,
  Loader2,
  Rocket,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import { PRICING_PLANS } from "~/data/pricing-plans";
import { loadScript } from "~/lib/load-script";
import { billingService } from "~/services/billing.service";
import { useStartOnboardingCheckoutMutation } from "~/hooks/use-billing-mutations";
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
    formState: { isValid },
  } = useForm<ChoosePlanFormValues>({
    resolver: zodResolver(choosePlanSchema),
    mode: "onChange",
    defaultValues: {
      billingPlan: pendingPlan ?? undefined,
      // Yearly plans aren't configured in Razorpay yet, so we lock the form
      // to MONTHLY. The toggle UI is hidden below.
      billingInterval: pendingBillingInterval ?? "MONTHLY",
    },
  });

  const selectedPlan = watch("billingPlan");

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

      const planConfig = PRICING_PLANS.find(
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


      {/* Heading */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <Rocket className="size-5 text-[#084734]" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Choose your plan</h2>
        <p className="mt-1.5 text-sm text-gray-500">
          Pick a plan and complete payment to continue. Cancel anytime from
          settings.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Plan cards — 3 plans (Basic / Growth / Advance), monthly billing only */}
        <Controller
          control={control}
          name="billingPlan"
          render={({ field }) => (
            <div
              role="radiogroup"
              aria-label="Pricing plan"
              className="grid grid-cols-1 gap-4 sm:grid-cols-3"
            >
              {PRICING_PLANS.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  selected={field.value === plan.id}
                  onSelect={() => field.onChange(plan.id)}
                />
              ))}
            </div>
          )}
        />

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

interface PlanCardProps {
  plan: (typeof PRICING_PLANS)[number];
  selected: boolean;
  onSelect: () => void;
}

function PlanCard({ plan, selected, onSelect }: PlanCardProps) {
  const formattedPrice = plan.priceMonthlyInr.toLocaleString("en-IN");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group relative flex h-full flex-col gap-4 rounded-2xl border-2 bg-white p-6 text-left shadow-sm transition-all",
        "hover:border-[#CEF17B] hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#CEF17B]/60",
        selected ? "border-[#CEF17B] shadow-md" : "border-transparent",
      )}
    >
      {plan.highlighted && (
        <span className="absolute -top-2.5 right-5 inline-flex items-center gap-1 rounded-full bg-[#084734] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#CEF17B]">
          <Sparkles className="size-3" />
          Popular
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            {plan.tagline}
          </p>
        </div>
        <SelectedIndicator selected={selected} />
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-bold text-gray-900">₹{formattedPrice}</span>
        <span className="text-sm text-gray-500">/month</span>
      </div>

      <ul className="space-y-2">
        {plan.features.map((feature) => (
          <li
            key={feature}
            className="flex items-start gap-2 text-sm text-gray-600"
          >
            <Check
              className="mt-0.5 size-4 shrink-0 text-[#084734]"
              aria-hidden
            />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

function SelectedIndicator({ selected }: { selected: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected
          ? "border-[#084734] bg-[#CEF17B]"
          : "border-gray-300 bg-white group-hover:border-[#CEF17B]",
      )}
    >
      {selected && <Check className="size-3 text-[#084734]" />}
    </div>
  );
}
