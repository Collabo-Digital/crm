import { BadRequestException } from '@nestjs/common';
import { DelayedError } from 'bullmq';
import { LockTimeoutError } from '../../../automation/engine/redis-lock';
import { RateLimitedError } from '../../../rate-limit/rate-limit.types';
import { TemplatePackJobs } from './template-pack-jobs';
import { TemplatePackProcessor } from './template-pack.processor';

function build() {
    const pack = { ensure: jest.fn(async () => undefined), reconcile: jest.fn(async () => undefined) };
    const templates = { sync: jest.fn(async () => ({ synced: 1, removed: 0 })) };
    const processor = new TemplatePackProcessor(pack as any, templates as any);
    jest.spyOn(processor['logger'], 'warn').mockImplementation(() => undefined);
    const job = (name: string, data: Record<string, unknown>) => ({ id: 'j1', name, data, attemptsMade: 0, moveToDelayed: jest.fn(async () => undefined) });
    return { processor, pack, templates, job };
}

describe('the template-pack processor', () => {
    it('routes each job by its name', async () => {
        const { processor, pack, templates, job } = build();
        await processor.process(job('ensure', { organizationId: 'org_1', wabaId: '1029', reason: 'connect' }) as any, 'tok');
        await processor.process(job('reconcile', { organizationId: 'org_1', wabaId: '1029' }) as any, 'tok');
        await processor.process(job('sync', { organizationId: 'org_1' }) as any, 'tok');
        expect(pack.ensure).toHaveBeenCalledWith('org_1', '1029', 'connect');
        expect(pack.reconcile).toHaveBeenCalledWith('org_1', '1029');
        expect(templates.sync).toHaveBeenCalledWith('org_1', { waitMs: 5_000 });
    });

    it('puts a job back for a minute, without using an attempt, while another holds the account', async () => {
        const { processor, pack, job } = build();
        pack.ensure.mockRejectedValueOnce(new LockTimeoutError('held'));
        const j = job('ensure', { organizationId: 'org_1', wabaId: '1029', reason: 'connect' });
        const before = Date.now();
        await expect(processor.process(j as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
        const calls = j.moveToDelayed.mock.calls as unknown as Array<[number, string]>;
        expect(calls[0][0]).toBeGreaterThanOrEqual(before + 60_000);
        expect(calls[0][1]).toBe('tok');
    });

    it('parks a rate-limited job until Meta allows it', async () => {
        const { processor, pack, job } = build();
        pack.reconcile.mockRejectedValueOnce(new RateLimitedError({ platform: 'meta', kind: 'buc', id: '1029' }, Date.now() + 5_000, 'BREAKER'));
        const j = job('reconcile', { organizationId: 'org_1', wabaId: '1029' });
        await expect(processor.process(j as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
        expect(j.moveToDelayed).toHaveBeenCalled();
    });

    it('lets a sync for an organization without WhatsApp finish, and fails other errors for a retry', async () => {
        const { processor, templates, pack, job } = build();
        templates.sync.mockRejectedValueOnce(new BadRequestException('Connect a WhatsApp number in Settings → Channels first.'));
        await expect(processor.process(job('sync', { organizationId: 'org_1' }) as any, 'tok')).resolves.toBeUndefined();
        pack.ensure.mockRejectedValueOnce(new Error('database down'));
        await expect(processor.process(job('ensure', { organizationId: 'org_1', wabaId: '1029', reason: 'manual' }) as any, 'tok')).rejects.toThrow('database down');
    });
});

describe('TemplatePackJobs', () => {
    function jobs() {
        const queue = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => ({})) };
        const automation = { getJob: jest.fn(async () => undefined), add: jest.fn(async () => ({})) };
        return { service: new TemplatePackJobs(queue as any, automation as any), queue, automation };
    }

    it('queues the engine’s managed-sync on the automation queue, deduped per organization', async () => {
        const { service, automation } = jobs();
        await service.managedSync('org_1');
        expect(automation.add).toHaveBeenCalledWith('managed-sync', { organizationId: 'org_1' }, expect.objectContaining({ jobId: 'managed-sync-org_1' }));
    });

    it('re-reads templates in review 10 minutes, an hour, 6 hours and a day after an ensure', async () => {
        const { service, queue } = jobs();
        await service.reconcileLater('org_1', '1029');
        expect(queue.add.mock.calls.map((c: any) => [c[0], c[2].jobId, c[2].delay])).toEqual([
            ['reconcile', 'pack-reconcile-org_1-10m', 600_000],
            ['reconcile', 'pack-reconcile-org_1-1h', 3_600_000],
            ['reconcile', 'pack-reconcile-org_1-6h', 21_600_000],
            ['reconcile', 'pack-reconcile-org_1-24h', 86_400_000],
        ]);
    });

    it('never throws when a job cannot be queued', async () => {
        const { service, queue } = jobs();
        queue.add.mockRejectedValue(new Error('redis down'));
        jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
        await expect(service.reconcile('org_1', '1029')).resolves.toBeUndefined();
        await expect(service.sync('org_1')).resolves.toBeUndefined();
    });
});
