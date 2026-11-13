import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Wizard steps, in the order the user sees them. */
export const ONBOARDING_STEPS = ['organization', 'business', 'channels', 'team', 'review'] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps that must be completed before onboarding can finish. */
const REQUIRED_ONBOARDING_STEPS: readonly OnboardingStep[] = ['organization', 'business'];

/** Reached only through `finish`, never through `completeStep`. */
const FINAL_ONBOARDING_STEP: OnboardingStep = 'review';

const MAX_ANSWER_LENGTH = 60;
const MAX_SELECTIONS = 20;

const onboardingStepSchema = z.enum(ONBOARDING_STEPS);
const shortAnswerSchema = z.string().trim().max(MAX_ANSWER_LENGTH);
const multiSelectAnswerSchema = z.array(shortAnswerSchema).max(MAX_SELECTIONS);

/** Field rules shared by the stored progress and the update request. */
const businessProfileFields = {
    sellModel: shortAnswerSchema,
    categories: multiSelectAnswerSchema,
    ordersPerMonth: shortAnswerSchema,
    teamSize: shortAnswerSchema,
    priorities: multiSelectAnswerSchema,
};

const StoredBusinessProfileSchema = z.object({
    sellModel: businessProfileFields.sellModel.catch(''),
    categories: businessProfileFields.categories.catch([]),
    ordersPerMonth: businessProfileFields.ordersPerMonth.catch(''),
    teamSize: businessProfileFields.teamSize.catch(''),
    priorities: businessProfileFields.priorities.catch([]),
});

export type BusinessProfile = z.output<typeof StoredBusinessProfileSchema>;

/**
 * Progress as stored in `organizations.onboarding_data`. Each field recovers
 * on its own, so one invalid value resets only that value, not the wizard.
 */
export const OnboardingDataSchema = z.object({
    currentStep: onboardingStepSchema.catch('organization'),
    // Keeps known steps, drops unknown ones and duplicates, returns them in wizard order.
    completedSteps: z
        .array(z.unknown())
        .transform((storedSteps) => ONBOARDING_STEPS.filter((step) => storedSteps.includes(step)))
        .catch([]),
    businessProfile: StoredBusinessProfileSchema.catch(() => StoredBusinessProfileSchema.parse({})),
});

export type OnboardingData = z.output<typeof OnboardingDataSchema>;

/** Request body for one wizard save. Unknown keys are rejected. */
export const UpdateOnboardingSchema = z.strictObject({
    currentStep: onboardingStepSchema.optional(),
    completeStep: onboardingStepSchema.optional(),
    businessProfile: z.strictObject(businessProfileFields).partial().optional(),
    finish: z.boolean().optional(),
});

export type UpdateOnboardingInput = z.output<typeof UpdateOnboardingSchema>;

export interface OnboardingUpdateResult {
    progress: OnboardingData;
    finished: boolean;
}

/** Reads stored progress. Never throws; anything unreadable falls back to defaults. */
export function parseOnboardingData(storedValue: unknown): OnboardingData {
    const parsed = OnboardingDataSchema.safeParse(storedValue);
    // Fails only when the stored value is not an object at all (null, string, array).
    return parsed.success ? parsed.data : OnboardingDataSchema.parse({});
}

function findMissingBusinessAnswers(profile: BusinessProfile, isSoloBusiness: boolean): string[] {
    const missingAnswers: string[] = [];
    if (!profile.sellModel) missingAnswers.push('how you sell');
    if (profile.categories.length === 0) missingAnswers.push('what you sell');
    if (!profile.ordersPerMonth) missingAnswers.push('orders a month');
    if (!isSoloBusiness && !profile.teamSize) missingAnswers.push('team size');
    return missingAnswers;
}

function assertBusinessProfileComplete(profile: BusinessProfile, isSoloBusiness: boolean): void {
    const missingAnswers = findMissingBusinessAnswers(profile, isSoloBusiness);
    if (missingAnswers.length > 0) {
        throw new BadRequestException(`Answer these to continue: ${missingAnswers.join(', ')}.`);
    }
}

/**
 * Applies one wizard save to the stored progress. Partial answers are always
 * kept; only completing the business step or finishing requires the answers.
 * `update` must already be parsed with `UpdateOnboardingSchema`.
 */
export function applyOnboardingUpdate(
    storedProgress: OnboardingData,
    update: UpdateOnboardingInput,
    isSoloBusiness: boolean,
): OnboardingUpdateResult {
    if (update.completeStep === FINAL_ONBOARDING_STEP) {
        throw new BadRequestException('Use finish to complete onboarding.');
    }

    const businessProfile: BusinessProfile = { ...storedProgress.businessProfile, ...update.businessProfile };
    const completedStepSet = new Set<OnboardingStep>(storedProgress.completedSteps);
    const isFinishing = update.finish === true;

    if (update.completeStep === 'business') {
        assertBusinessProfileComplete(businessProfile, isSoloBusiness);
    }
    if (update.completeStep) {
        completedStepSet.add(update.completeStep);
    }

    if (isFinishing) {
        const incompleteRequiredSteps = REQUIRED_ONBOARDING_STEPS.filter((step) => !completedStepSet.has(step));
        if (incompleteRequiredSteps.length > 0) {
            throw new BadRequestException(`Finish these steps first: ${incompleteRequiredSteps.join(', ')}.`);
        }
        // Answers may have been cleared after the business step was completed.
        assertBusinessProfileComplete(businessProfile, isSoloBusiness);
        completedStepSet.add(FINAL_ONBOARDING_STEP);
    }

    return {
        progress: {
            currentStep: update.currentStep ?? storedProgress.currentStep,
            completedSteps: ONBOARDING_STEPS.filter((step) => completedStepSet.has(step)),
            businessProfile,
        },
        finished: isFinishing,
    };
}