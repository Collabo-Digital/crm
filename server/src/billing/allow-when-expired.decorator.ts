import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_EXPIRED_KEY = 'allowWhenExpired';

/**
 * Lets writes through BillingAccessGuard while the workspace is read-only:
 * the routes that keep the way out open (signing in and out, the profile,
 * billing and subscribing, making or deleting a workspace).
 */
export const AllowWhenExpired = () => SetMetadata(ALLOW_WHEN_EXPIRED_KEY, true);
