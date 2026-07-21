import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Flips DRAFT products to ACTIVE when their `publishedAt` falls in the past.
 * Runs every minute via `@Cron`. `ScheduleModule.forRoot()` is already in
 * `app.module.ts`, so this provider just needs to be registered in
 * `ProductModule.providers`.
 *
 * If the flipped product was previously SYNCED to Shopify, we re-stamp its
 * sync metadata to OUT_OF_SYNC so the merchant sees the badge and can re-push
 * on demand. We do NOT auto-enqueue a push from here because that surprises
 * users (some merchants schedule publish for SEO reasons and want to control
 * the Shopify push timing separately).
 */
@Injectable()
export class ProductPublishScheduler {
  private readonly logger = new Logger(ProductPublishScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async flipDueProducts() {
    const due = await this.prisma.product.findMany({
      where: {
        status: 'DRAFT',
        publishedAt: { not: null, lte: new Date() },
        deletedAt: null,
      },
      select: { id: true, title: true, metadata: true },
      take: 100,
    });

    if (due.length === 0) return;

    for (const p of due) {
      try {
        const meta = (p.metadata as Prisma.JsonObject) ?? {};
        const sync = meta.shopifySync as
          | { status?: string; shopifyProductId?: string }
          | undefined;
        const wasSynced = sync?.status === 'SYNCED';

        await this.prisma.product.update({
          where: { id: p.id },
          data: {
            status: 'ACTIVE',
            metadata: wasSynced
              ? ({
                  ...meta,
                  shopifySync: { ...sync, status: 'OUT_OF_SYNC' },
                } as Prisma.InputJsonObject)
              : undefined,
          },
        });
        this.logger.log(`Auto-published product ${p.title} (${p.id}).`);
      } catch (err) {
        this.logger.warn(`Failed to auto-publish ${p.id}: ${err}`);
      }
    }
  }
}
