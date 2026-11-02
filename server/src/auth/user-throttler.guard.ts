import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits per signed-in member, and per IP address for public routes
 * (sign-in, webhooks). Counting signed-in requests by IP would put a whole
 * office, or every user behind the production proxy, in one bucket.
 * Registered after JwtAuthGuard, so the member is known by the time it runs.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        const userId = (req.user as { sub?: string } | undefined)?.sub;
        return userId ? `user:${userId}` : (req.ip as string);
    }
}
