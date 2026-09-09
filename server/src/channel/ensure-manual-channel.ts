import { Prisma, PrismaClient, ChannelPlatform, ChannelStatus } from '@prisma/client';

/**
 * Anything that can run a Prisma query: the root client, the injected
 * `PrismaService`, or a `$transaction` callback client.
 */
type Db = Pick<PrismaClient, 'channel'> | Prisma.TransactionClient;

/**
 * The org's MANUAL channel, created on first use.
 *
 * Replaces the five identical `channel.upsert({ where: { organizationId_platform } })`
 * calls that used to lazily seed it. That compound selector is gone: a Channel
 * row is now ONE CONNECTED ACCOUNT, so an org may hold several rows of the same
 * platform (many Instagram accounts) and `(organization_id, platform)` can no
 * longer be a plain unique.
 *
 * MANUAL is still strictly one-per-org, but the guarantee now lives in the
 * partial unique index `channels_one_active_per_org_platform_key` — which
 * Prisma cannot express, and therefore cannot compile an `upsert` against.
 * Hence find-then-create, with P2002 (two concurrent first-writes racing) read
 * back rather than thrown: the loser of the race wants the winner's row, not an
 * error.
 */
export async function ensureManualChannel(
    db: Db,
    orgId: string,
): Promise<{ id: string }> {
    const existing = await db.channel.findFirst({
        where: { organizationId: orgId, platform: ChannelPlatform.MANUAL },
        select: { id: true },
    });
    if (existing) return existing;

    try {
        return await db.channel.create({
            data: {
                organizationId: orgId,
                platform: ChannelPlatform.MANUAL,
                name: 'In-Store / Manual',
                status: ChannelStatus.CONNECTED,
                isEnabled: true,
            },
            select: { id: true },
        });
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            const raced = await db.channel.findFirst({
                where: { organizationId: orgId, platform: ChannelPlatform.MANUAL },
                select: { id: true },
            });
            if (raced) return raced;
        }
        throw error;
    }
}
