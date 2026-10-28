import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * What a workspace's members may upload in one day (UTC): chat attachments
 * and template header files, which stay on the media volume every workspace
 * shares. Busy brands send well under this; it stops one account filling
 * the disk.
 */
export const DAILY_UPLOAD_BYTES = 5 * 1024 ** 3;

/** Uploads one member may start a minute, per upload route. Files are picked one at a time. */
export const UPLOAD_THROTTLE = { default: { ttl: 60_000, limit: 20 } };

@Injectable()
export class UploadQuotaService {
    constructor(private readonly redis: RedisService) { }

    /** Refuse at once when the day is used up, before the file is read. */
    async assertRoom(orgId: string): Promise<void> {
        if ((await this.redis.uploadedBytesToday(orgId)) >= DAILY_UPLOAD_BYTES) throw quotaReached();
    }

    /** Count a file against the workspace's day; refused when it would go over. */
    async reserve(orgId: string, bytes: number): Promise<void> {
        if (!(await this.redis.addUploadedBytes(orgId, bytes, DAILY_UPLOAD_BYTES))) throw quotaReached();
    }
}

/** On an upload route: the daily quota is checked before the file is read into memory. */
@Injectable()
export class UploadQuotaGuard implements CanActivate {
    constructor(private readonly quota: UploadQuotaService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const orgId = context.switchToHttp().getRequest<{ user?: { orgId?: string } }>().user?.orgId;
        if (orgId) await this.quota.assertRoom(orgId);
        return true;
    }
}

function quotaReached() {
    return new HttpException(
        `This workspace has uploaded ${DAILY_UPLOAD_BYTES / 1024 ** 3} GB of files today, the daily limit. Uploads open again after midnight UTC.`,
        HttpStatus.TOO_MANY_REQUESTS,
    );
}
