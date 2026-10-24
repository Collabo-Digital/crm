import { MessageSource } from '@prisma/client';
import { Priority } from '../../rate-limit/rate-limit.types';
import { OutboundSweeper, stuckAction } from './outbound.sweeper';

const now = new Date('2026-10-25T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function build(rows: { people: unknown[]; broadcasts?: unknown[] }, jobs: Record<string, { state: string } | undefined>) {
    const removed: string[] = [];
    const prisma = {
        channel: { findMany: jest.fn().mockResolvedValue([{ organizationId: 'org1' }]) },
        message: { findMany: jest.fn().mockResolvedValueOnce(rows.people).mockResolvedValueOnce(rows.broadcasts ?? []) },
    };
    const queue = {
        getJob: jest.fn().mockImplementation(async (id: string) => {
            const j = jobs[id];
            return j ? { getState: async () => j.state, remove: async () => removed.push(id) } : undefined;
        }),
    };
    const send = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const sender = { giveUp: jest.fn().mockResolvedValue(undefined) };
    const sweeper = new OutboundSweeper(prisma as never, send as never, sender as never, queue as never);
    return { sweeper, prisma, send, sender, removed };
}

describe('OutboundSweeper', () => {
    it('queues again a message whose job was lost or failed for stalling, and leaves live jobs alone', async () => {
        const { sweeper, send, removed, prisma } = build(
            {
                people: [
                    { id: 'lost', source: MessageSource.AGENT, body: { humanAgentTag: false }, createdAt: minutesAgo(3) },
                    { id: 'stalled', source: MessageSource.AUTOMATION, body: {}, createdAt: minutesAgo(5) },
                    { id: 'waiting', source: MessageSource.API, body: {}, createdAt: minutesAgo(5) },
                ],
                broadcasts: [{ id: 'parked', source: MessageSource.BROADCAST, body: {}, createdAt: minutesAgo(20) }],
            },
            { 'deliver-stalled': { state: 'failed' }, 'deliver-waiting': { state: 'prioritized' }, 'deliver-parked': { state: 'delayed' } },
        );

        expect(await sweeper.sweep(now)).toBe(2);
        expect(send.enqueue).toHaveBeenCalledWith('lost', false, Priority.INTERACTIVE);
        expect(send.enqueue).toHaveBeenCalledWith('stalled', false, Priority.NORMAL);
        expect(send.enqueue).toHaveBeenCalledTimes(2);
        expect(removed).toEqual(['deliver-stalled']);
        const where = prisma.message.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ organizationId: { in: ['org1'] }, status: 'QUEUED', externalId: null, createdAt: { lt: minutesAgo(2) } });
    });

    it('fails a message too old to send without surprising the customer', async () => {
        const { sweeper, send, sender } = build(
            { people: [{ id: 'old', source: MessageSource.AGENT, body: {}, createdAt: minutesAgo(45) }] },
            {},
        );
        await sweeper.sweep(now);
        expect(send.enqueue).not.toHaveBeenCalled();
        expect(sender.giveUp).toHaveBeenCalledWith('old', expect.stringMatching(/not sent/));
    });
});

describe('stuckAction', () => {
    it('gives a reply half an hour and anything else six hours', () => {
        expect(stuckAction(minutesAgo(29), Priority.INTERACTIVE, now)).toBe('requeue');
        expect(stuckAction(minutesAgo(31), Priority.INTERACTIVE, now)).toBe('give-up');
        expect(stuckAction(minutesAgo(5 * 60), Priority.BULK, now)).toBe('requeue');
        expect(stuckAction(minutesAgo(7 * 60), Priority.NORMAL, now)).toBe('give-up');
    });
});
