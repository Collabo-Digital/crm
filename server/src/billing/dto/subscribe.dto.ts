import { StartOnboardingCheckoutDto } from './start-onboarding-checkout.dto';

/** Body of POST /billing/subscribe: the plan, interval and currency, as at onboarding. */
export class SubscribeDto extends StartOnboardingCheckoutDto { }
