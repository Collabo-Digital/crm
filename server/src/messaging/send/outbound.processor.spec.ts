import { DelayedError, Job } from 'bullmq';
import { Priority, RateLimitedError } from '../../rate-limit/rate-limit.types';
import { OutboundProcessor } from './outbound.processor';
import type { OutboundJobData } from './outbound.queue';

function job(overrides: Partial<{ attemptsMade: number; timestamp: number; priority: number }> = {}) {
    return {
        id: 'deliver-m1',
        name: 'deliver',
        data: { kind: 'deliver', messageId: 'm1', humanAgentTag: false },
        opts: { attempts: 5, priority: overrides.priority ?? Priority.INTERACTIVE },
        attemptsMade: overrides.attemptsMade ?? 0,
        timestamp: overrides.timestamp ?? Date.now(),
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<OutboundJobData>;
}

function build(error: unknown) {
    const sender = { deliver: jest.fn().mockRejectedValue(error), giveUp: jest.fn().mockResolvedValue(undefined) };
    return { processor: new OutboundProcessor(sender as never), sender };
}

const pairLimit = () => new RateLimitedError({ platform: 'meta', kind: 'phone', id: 'PN1' }, Date.now() + 10_000, 'BREAKER', 131056);

describe('OutboundProcessor', () => {
    it('fails the message, with its broadcast recipient, when the last attempt fails', async () => {
        const err = new Error('fetch failed');
        const { processor, sender } = build(err);
        await expect(processor.process(job({ attemptsMade: 4 }), 'token')).rejects.toBe(err);
        expect(sender.giveUp).toHaveBeenCalledWith('m1', 'Meta could not be reached. Try sending again.');
    });

    it('leaves earlier attempts to the retry', async () => {
        const err = new Error('fetch failed');
        const { processor, sender } = build(err);
        await expect(processor.process(job({ attemptsMade: 1 }), 'token')).rejects.toBe(err);
        expect(sender.giveUp).not.toHaveBeenCalled();
    });

    it('parks a rate-limited message while it is still worth sending', async () => {
        const { processor, sender } = build(pairLimit());
        const j = job({ attemptsMade: 4 });
        await expect(processor.process(j, 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(j.moveToDelayed).toHaveBeenCalled();
        expect(sender.giveUp).not.toHaveBeenCalled();
    });

    it('fails a reply that stayed rate limited for over half an hour, with Meta’s reason', async () => {
        const { processor, sender } = build(pairLimit());
        const j = job({ timestamp: Date.now() - 31 * 60_000 });
        await processor.process(j, 'token');
        expect(j.moveToDelayed).not.toHaveBeenCalled();
        expect(sender.giveUp).toHaveBeenCalledWith('m1', expect.stringMatching(/Too many messages went to this customer/), 131056);
    });

    it('gives a broadcast message longer before failing it', async () => {
        const { processor, sender } = build(pairLimit());
        const j = job({ timestamp: Date.now() - 31 * 60_000, priority: Priority.BULK + 40 });
        await expect(processor.process(j, 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(sender.giveUp).not.toHaveBeenCalled();
    });
});
