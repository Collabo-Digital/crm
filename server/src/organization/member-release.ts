import { ConversationStatus, Prisma } from '@prisma/client';

/**
 * Hand back what a member leaving these organizations was holding. Their open
 * and snoozed conversations go back to the queue, keeping their team so that
 * team's queue picks them up: agents only see their own chats and the queue,
 * so a chat left assigned to someone who is gone is seen by nobody but
 * admins. They also leave the organizations' inbox teams, so round robin
 * stops picking them. Returns the conversations released.
 */
export async function releaseMemberWork(
    tx: Prisma.TransactionClient,
    orgIds: string[],
    userId: string,
): Promise<Array<{ id: string; organizationId: string }>> {
    if (orgIds.length === 0) return [];
    const held = await tx.conversation.findMany({
        where: { organizationId: { in: orgIds }, assignedUserId: userId, status: { not: ConversationStatus.CLOSED } },
        select: { id: true, organizationId: true },
    });
    if (held.length > 0) {
        await tx.conversation.updateMany({
            where: { id: { in: held.map((c) => c.id) }, assignedUserId: userId },
            data: { assignedUserId: null },
        });
    }
    await tx.inboxTeamMember.deleteMany({ where: { userId, team: { organizationId: { in: orgIds } } } });
    return held;
}
