import { z } from "zod";

/** Form schema for the onboarding choose-plan step. */
export const choosePlanSchema = z.object({
  // Only the plans sold at checkout can be picked; the cards say which.
  billingPlan: z.enum(["BASIC", "GROWTH", "SCALE", "ADVANCE"]),
  billingInterval: z.enum(["MONTHLY", "YEARLY"]),
  currency: z.enum(["INR", "USD"]),
});

export type ChoosePlanFormValues = z.infer<typeof choosePlanSchema>;
