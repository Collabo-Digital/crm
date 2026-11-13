import type { OnboardingAudience, OnboardingBusinessProfile } from "~/types/api";

/**
 * The Business profile step's questions. Answers are stored as these `value`
 * ids (see `businessProfile` in server/src/organization/onboarding-data.ts),
 * so a label can be reworded without touching saved answers.
 */
interface Option {
  value: string;
  label: string;
}

export const SELL_MODELS: ReadonlyArray<Option & { hint: string; short: string }> = [
  { value: "own_brand", label: "My own brand", hint: "Direct to customers", short: "Own brand" },
  { value: "retailer", label: "Retailer", hint: "I resell other brands", short: "Retailer" },
  { value: "wholesale", label: "Wholesale", hint: "Bulk to businesses", short: "Wholesale" },
  { value: "mix", label: "A mix", hint: "More than one", short: "A mix" },
];

export const CATEGORIES: readonly Option[] = [
  { value: "clothing", label: "Clothing" },
  { value: "footwear", label: "Footwear" },
  { value: "accessories", label: "Accessories" },
  { value: "beauty", label: "Beauty & skincare" },
  { value: "jewellery", label: "Jewellery" },
  { value: "electronics", label: "Electronics" },
  { value: "home_decor", label: "Home décor" },
  { value: "kitchen", label: "Kitchen" },
  { value: "food", label: "Food & snacks" },
  { value: "kids", label: "Kids & baby" },
  { value: "health", label: "Health & wellness" },
  { value: "other", label: "Other" },
];

export const ORDER_VOLUMES: readonly Option[] = [
  { value: "starting", label: "Just starting" },
  { value: "under_100", label: "Under 100" },
  { value: "100_1000", label: "100–1,000" },
  { value: "1000_10000", label: "1,000–10,000" },
  { value: "10000_plus", label: "10,000+" },
];

/** What a "Just me" workspace stores for team size: the question isn't asked. */
export const SOLO_TEAM_SIZE = "just_me";

export const TEAM_SIZES: readonly Option[] = [
  { value: SOLO_TEAM_SIZE, label: "Just me" },
  { value: "2_5", label: "2–5" },
  { value: "6_20", label: "6–20" },
  { value: "21_50", label: "21–50" },
  { value: "50_plus", label: "50+" },
];

export const PRIORITIES: ReadonlyArray<Option & { hint: string }> = [
  { value: "reply_faster", label: "Reply to customers faster", hint: "Shared inbox, quick replies" },
  { value: "orders_shipping", label: "Manage orders and shipping", hint: "Packing, labels, COD" },
  { value: "campaigns", label: "Run WhatsApp campaigns", hint: "Broadcasts and automations" },
  { value: "stock", label: "Keep stock accurate", hint: "Inventory and low-stock alerts" },
];

/** The label for a stored answer. An id this build doesn't know is shown as stored. */
export function optionLabel(options: readonly Option[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** The questions still unanswered, as the step's own headings. Mirrors the server's check. */
export function missingBusinessAnswers(profile: OnboardingBusinessProfile, audience: OnboardingAudience): string[] {
  const missing: string[] = [];
  if (!profile.sellModel) missing.push("How do you sell?");
  if (profile.categories.length === 0) missing.push("What do you sell?");
  if (!profile.ordersPerMonth) missing.push("Orders a month");
  if (audience === "team" && !profile.teamSize) missing.push("People working with you");
  return missing;
}

/** "Own brand · Clothing +2": the answers in one line, for the sidebar. Null until there are any. */
export function businessSummary(profile: OnboardingBusinessProfile): string | null {
  const sellModel = SELL_MODELS.find((model) => model.value === profile.sellModel)?.short;
  const [first, ...others] = profile.categories;
  const categories = first && `${optionLabel(CATEGORIES, first)}${others.length > 0 ? ` +${others.length}` : ""}`;
  return [sellModel, categories].filter(Boolean).join(" · ") || null;
}
