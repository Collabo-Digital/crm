import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, Check, CirclePlus, Loader2, Package, Store, Tag, type LucideIcon } from "lucide-react";

import { ChoiceSegments } from "~/components/app/choice-segments";
import { StepFrame } from "~/components/app/onboarding/step-frame";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { useOnboardingWizard, useUpdateOnboardingMutation, useWizardStep } from "~/hooks/use-onboarding";
import {
  CATEGORIES,
  missingBusinessAnswers,
  ORDER_VOLUMES,
  PRIORITIES,
  SELL_MODELS,
  SOLO_TEAM_SIZE,
  TEAM_SIZES,
} from "~/lib/onboarding-business";
import { cn } from "~/lib/utils";
import type { OnboardingBusinessProfile } from "~/types/api";

export function meta() {
  return [{ title: "Tell us about your business | Collabo CRM" }];
}

const SELL_MODEL_ICONS: Record<string, LucideIcon> = {
  own_brand: Tag,
  retailer: Store,
  wholesale: Package,
  mix: CirclePlus,
};

/** Answers pause this long before they are saved. */
const AUTOSAVE_DELAY = 600;

const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

function Question({
  title,
  note,
  aside,
  missing,
  children,
}: {
  title: string;
  /** Greyed text after the title: "(optional)". */
  note?: string;
  aside?: string;
  /** Shown once the owner has tried to continue without answering. */
  missing?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-section">
          {title}
          {note && <span className="text-body text-muted-foreground"> {note}</span>}
        </h2>
        {aside && <p className="text-caption text-muted-foreground">{aside}</p>}
      </div>
      <div className="mt-4">{children}</div>
      {missing && <p className="mt-3 text-caption text-danger-text">Answer this to continue.</p>}
    </section>
  );
}

/**
 * Setup step 3: how the business sells, what, and how much.
 *
 * Answers save themselves as they are picked, so a half-answered step is kept
 * if the owner leaves. The step only counts as done once the required
 * questions are answered; "What matters most" is optional. A "Just me"
 * workspace isn't asked for its team size.
 */
function BusinessForm({ initial }: { initial: OnboardingBusinessProfile }) {
  const { orgId, orgName, audience } = useOnboardingWizard();
  const step = useWizardStep("business");
  const autosave = useUpdateOnboardingMutation(orgId);
  const saveAnswers = autosave.mutate;

  const [profile, setProfile] = useState(initial);
  // The answers the server is known to hold: the ones loaded, then each autosave that lands.
  const [saved, setSaved] = useState(initial);
  const [attempted, setAttempted] = useState(false);

  const isSolo = audience === "solo";
  const answers = isSolo ? { ...profile, teamSize: SOLO_TEAM_SIZE } : profile;
  const missing = missingBusinessAnswers(answers, audience);
  const isMissing = (question: string) => attempted && missing.includes(question);
  const busy = step.isCompleting || step.isLeaving;
  const change = (patch: Partial<OnboardingBusinessProfile>) => setProfile((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (profile === saved) return;
    const timer = setTimeout(
      () => saveAnswers({ businessProfile: profile }, { onSuccess: () => setSaved(profile) }),
      AUTOSAVE_DELAY,
    );
    return () => clearTimeout(timer);
  }, [profile, saved, saveAnswers]);

  async function handleContinue() {
    setAttempted(true);
    if (missing.length > 0) return;
    await step.complete({ businessProfile: answers });
  }

  return (
    <StepFrame
      title="Tell us about your business"
      description="A few quick questions about how you sell, so Collabo can be set up around your business."
      status={
        profile === saved
          ? step.isDone
            ? "Progress saved"
            : `${orgName ?? "Your workspace"} is created · progress saved`
          : undefined
      }
      exit={
        <Button variant="outline" disabled={busy} onClick={() => void step.exit({ businessProfile: profile })}>
          {step.isLeaving && <Loader2 className="animate-spin" aria-hidden />}
          Save & exit
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" asChild>
            <Link to={step.previousPath ?? "/onboarding"}>
              <ArrowLeft aria-hidden />
              Previous
            </Link>
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-4">
            {attempted && missing.length > 0 && (
              <p className="text-body text-danger-text">
                Answer {missing.length} more {missing.length === 1 ? "question" : "questions"} to continue
              </p>
            )}
            <Button size="lg" className="h-11 px-5" disabled={busy} onClick={() => void handleContinue()}>
              {step.isCompleting && <Loader2 className="animate-spin" aria-hidden />}
              Save & continue
              {!step.isCompleting && <ArrowRight aria-hidden />}
            </Button>
          </div>
        </>
      }
    >
      <Question title="How do you sell?" missing={isMissing("How do you sell?")}>
        <div role="radiogroup" aria-label="How do you sell?" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SELL_MODELS.map(({ value, label, hint }) => {
            const Icon = SELL_MODEL_ICONS[value];
            const checked = profile.sellModel === value;
            return (
              <label
                key={value}
                className={cn(
                  "cursor-pointer rounded-xl border bg-card p-4 transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  checked ? "border-brand-strong bg-brand/15 ring-2 ring-brand/60" : "border-border hover:border-input",
                )}
              >
                <input
                  type="radio"
                  name="sellModel"
                  value={value}
                  checked={checked}
                  onChange={() => change({ sellModel: value })}
                  className="sr-only"
                />
                <Icon className="size-5 text-brand-strong" aria-hidden />
                <span className="mt-3 block text-body font-semibold">{label}</span>
                <span className="block text-caption text-muted-foreground">{hint}</span>
              </label>
            );
          })}
        </div>
      </Question>

      <Question
        title="What do you sell?"
        aside={`${profile.categories.length > 0 ? `${profile.categories.length} selected · ` : ""}pick all that apply`}
        missing={isMissing("What do you sell?")}
      >
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(({ value, label }) => {
            const pressed = profile.categories.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={pressed}
                onClick={() => change({ categories: toggled(profile.categories, value) })}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-body font-medium transition-colors",
                  pressed
                    ? "border-brand-strong bg-brand-strong text-background"
                    : "border-input bg-card hover:bg-muted",
                )}
              >
                {pressed && <Check className="size-3.5" aria-hidden />}
                {label}
              </button>
            );
          })}
        </div>
      </Question>

      <Question
        title="How big is your business?"
        missing={isMissing("Orders a month") || isMissing("People working with you")}
      >
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-label">Orders a month</p>
            <ChoiceSegments
              label="Orders a month"
              value={profile.ordersPerMonth}
              options={ORDER_VOLUMES}
              onChange={(ordersPerMonth) => change({ ordersPerMonth })}
            />
          </div>
          {!isSolo && (
            <div>
              <p className="mb-2 text-label">People working with you</p>
              <ChoiceSegments
                label="People working with you"
                value={profile.teamSize}
                options={TEAM_SIZES}
                onChange={(teamSize) => change({ teamSize })}
              />
            </div>
          )}
        </div>
      </Question>

      <Question title="What matters most right now?" note="(optional)">
        <p className="-mt-2 mb-4 text-body text-muted-foreground">Pick the jobs you want Collabo to help with first.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {PRIORITIES.map(({ value, label, hint }) => {
            const checked = profile.priorities.includes(value);
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 transition-colors",
                  checked ? "border-brand-strong bg-brand/15 ring-2 ring-brand/60" : "border-border hover:border-input",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => change({ priorities: toggled(profile.priorities, value) })}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-body font-semibold">{label}</span>
                  <span className="block text-caption text-muted-foreground">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </Question>
    </StepFrame>
  );
}

export default function BusinessStepPage() {
  // The guard only renders this step once the progress has loaded.
  const { onboarding } = useOnboardingWizard();
  return onboarding ? <BusinessForm initial={onboarding.progress.businessProfile} /> : null;
}
