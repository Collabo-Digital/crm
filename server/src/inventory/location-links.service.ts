import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ChannelPlatform, ChannelStatus, Prisma, ShopifyLocationAction } from '@prisma/client';
import {
  PUSH_JOB_OPTS,
  SHOPIFY_PUSH_QUEUE,
  ShopifyPushJobData,
  pushJobId,
} from '../channel/shopify-push.queue';
import { Priority } from '../rate-limit/rate-limit.types';

type Tx = Prisma.TransactionClient;

/** How long a follow-up stock sync waits for the one running to finish. */
const FOLLOW_UP_DELAY_MS = 2 * 60 * 1000;

/**
 * A scanner-safe location code from a name, unique within the org.
 * "Kochi Store" → "KOCHIS"; on collision "KOCHIS2", "KOCHIS3"…
 *
 * Must satisfy the DTO's ^[A-Z0-9]{1,8}$ so a code minted here is still valid
 * if a merchant later edits that location through the API.
 */
export function deriveLocationCode(name: string, used: Set<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'WH';
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, 8 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  // 999 locations sharing a six-character stem is not a real shop, but a
  // silent duplicate would trip the (org, code) unique — fail loudly.
  throw new Error(`Could not derive a unique location code from "${name}"`);
}

/**
 * Linking a stock location to a Shopify location — sharing one stock figure
 * between them — and the merchant's decision that records it.
 *
 * `Warehouse.shopifyLocationId` is what every sync path reads; the
 * ShopifyLocationLink row is the decision shown back to the merchant. Both
 * change together here, inside the caller's transaction, so they cannot
 * disagree.
 */
@Injectable()
export class LocationLinkService {
  private readonly logger = new Logger(LocationLinkService.name);

  constructor(
    // Queue by name, as InventoryService does: InventoryModule must not
    // import ChannelModule.
    @InjectQueue(SHOPIFY_PUSH_QUEUE)
    private readonly shopifyPushQueue: Queue<ShopifyPushJobData>,
  ) {}

  /** The org's Shopify location by id, from its connected store. */
  async findShopifyLocation(tx: Tx, orgId: string, shopifyLocationId: string) {
    const row = await tx.shopifyLocationLink.findFirst({
      where: {
        organizationId: orgId,
        shopifyLocationId,
        channel: { platform: ChannelPlatform.SHOPIFY, status: { not: ChannelStatus.DISCONNECTED } },
      },
    });
    if (!row) {
      throw new BadRequestException(
        "That Shopify location wasn't found. Refresh the list and try again.",
      );
    }
    return row;
  }

  /**
   * Make `warehouse` share stock with a Shopify location. Refuses a Shopify
   * location already linked to another location, and a location already
   * linked to another Shopify location — each side links to one.
   */
  async link(
    tx: Tx,
    orgId: string,
    warehouse: { id: string; name: string; shopifyLocationId: string | null },
    shopifyLocationId: string,
    action: Extract<ShopifyLocationAction, 'LINK' | 'CREATE'> = ShopifyLocationAction.LINK,
  ): Promise<void> {
    const location = await this.findShopifyLocation(tx, orgId, shopifyLocationId);
    const other = await tx.warehouse.findFirst({
      where: { organizationId: orgId, shopifyLocationId, id: { not: warehouse.id } },
      select: { name: true },
    });
    if (other) {
      throw new BadRequestException(`That Shopify location is already linked to ${other.name}.`);
    }
    if (warehouse.shopifyLocationId && warehouse.shopifyLocationId !== shopifyLocationId) {
      throw new BadRequestException(
        `${warehouse.name} already shares stock with another Shopify location. Unlink it first.`,
      );
    }
    await tx.warehouse.update({
      where: { id: warehouse.id },
      data: { shopifyLocationId },
    });
    await tx.shopifyLocationLink.update({
      where: { id: location.id },
      data: { action, warehouseId: warehouse.id, decidedAt: new Date() },
    });
  }

  /**
   * Stop `warehouse` sharing stock with its Shopify location. That Shopify
   * location then waits for a decision again rather than being left in limbo.
   */
  async unlink(
    tx: Tx,
    orgId: string,
    warehouse: { id: string; shopifyLocationId: string | null },
  ): Promise<void> {
    const { shopifyLocationId } = warehouse;
    if (!shopifyLocationId) return;
    await tx.warehouse.update({
      where: { id: warehouse.id },
      data: { shopifyLocationId: null },
    });
    await tx.shopifyLocationLink.updateMany({
      where: { organizationId: orgId, shopifyLocationId },
      data: { action: null, warehouseId: null, decidedAt: null },
    });
  }

  /** Leave a Shopify location out of stock sync, unlinking whatever shared its stock. */
  async ignore(tx: Tx, orgId: string, shopifyLocationId: string): Promise<void> {
    const location = await this.findShopifyLocation(tx, orgId, shopifyLocationId);
    await tx.warehouse.updateMany({
      where: { organizationId: orgId, shopifyLocationId },
      data: { shopifyLocationId: null },
    });
    await tx.shopifyLocationLink.update({
      where: { id: location.id },
      data: { action: ShopifyLocationAction.IGNORE, warehouseId: null, decidedAt: new Date() },
    });
  }

  /**
   * Bring newly linked locations' stock in line with Shopify: the ones whose
   * counts the merchant kept are sent to Shopify first, then every linked
   * location is pulled.
   *
   * One job per org at a time, under the enable flow's job id: two pulls
   * running together would each apply the same difference and count it
   * twice. A job still waiting has read nothing yet, so it takes these
   * locations too; one already running gets a single follow-up, started late
   * enough to come after it.
   *
   * Fire-and-forget: a lost job is recovered by the next channel sync's pull,
   * except that kept counts would then be overwritten — hence logged loudly.
   */
  async queueStockSync(orgId: string, pushWarehouseIds: string[]): Promise<void> {
    const jobId = pushJobId.locations(orgId);
    try {
      for (const id of [jobId, `${jobId}-next`]) {
        const existing = await this.shopifyPushQueue.getJob(id);
        const state = existing ? await existing.getState() : null;
        if (state === 'active') continue;
        if (existing && state !== 'completed' && state !== 'failed') {
          const data: ShopifyPushJobData = existing.data;
          if (data.type === 'sync-locations') {
            const merged: ShopifyPushJobData = {
              ...data,
              pushWarehouseIds: [...new Set([...(data.pushWarehouseIds ?? []), ...pushWarehouseIds])],
            };
            await (existing as Job<ShopifyPushJobData>).updateData(merged);
          }
          return;
        }
        if (existing) await existing.remove();
        await this.shopifyPushQueue.add(
          'sync-locations',
          {
            type: 'sync-locations',
            organizationId: orgId,
            pushWarehouseIds,
            priority: Priority.NORMAL,
          },
          {
            ...PUSH_JOB_OPTS,
            jobId: id,
            priority: Priority.NORMAL,
            ...(id === jobId ? {} : { delay: FOLLOW_UP_DELAY_MS }),
          },
        );
        return;
      }
      throw new Error('a stock sync and its follow-up are both running');
    } catch (err) {
      this.logger.error(
        `Could not queue the stock sync for newly linked locations of org ${orgId}` +
          (pushWarehouseIds.length ? ` (counts to send: ${pushWarehouseIds.join(', ')})` : '') +
          `: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
