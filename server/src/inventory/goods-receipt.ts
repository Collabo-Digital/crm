import { ForbiddenException } from '@nestjs/common';
import { StockBucket } from '@prisma/client';
import { hasPermission } from '../auth/permissions';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';

/**
 * Goods in is booked as a stock adjustment that only adds units, with reason
 * `received`. A member holding `inventory.receive` without `inventory.adjust`
 * may book those and nothing else: no "set to", no removal, nothing into
 * Reserved (that is what orders hold), so they cannot correct or write off a
 * count. Members with `inventory.adjust` are not narrowed.
 */
export function assertMayAdjust(
  user: Pick<SessionPayload, 'role' | 'permissions'>,
  reason: string | undefined,
  lines: ReadonlyArray<{ bucket: StockBucket; delta?: number; setTo?: number }>,
): void {
  if (hasPermission(user.role, user.permissions, 'inventory.adjust')) return;
  const goodsIn =
    reason === 'received' &&
    lines.every((line) => line.setTo === undefined && (line.delta ?? 0) > 0 && line.bucket !== StockBucket.RESERVED);
  if (!goodsIn) {
    throw new ForbiddenException('Missing permission: inventory.adjust. Receiving stock can only add units, with the reason "Received".');
  }
}
