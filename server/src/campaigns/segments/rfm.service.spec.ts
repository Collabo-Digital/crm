import { RfmService } from './rfm.service';

describe('RFM score refresh', () => {
    function setup(latest: Date | null) {
        const steps: string[] = [];
        const tx = {
            $executeRaw: jest.fn(async (sql: TemplateStringsArray) => steps.push(sql.join('?').includes('pg_advisory_xact_lock') ? 'lock' : 'other')),
            $queryRaw: jest.fn(async () => {
                steps.push('stats');
                return [{ customer_id: 'cust_1', r: 5, f: 5, m: 4, last_order: new Date(), orders: 6 }];
            }),
            customerRfmScore: {
                findFirst: jest.fn(async () => (latest ? { computedAt: latest } : null)),
                deleteMany: jest.fn(async () => steps.push('delete')),
                createMany: jest.fn(async () => steps.push('insert')),
            },
        };
        const prisma = {
            ...tx,
            $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, _opts: unknown) => fn(tx)),
        };
        return { service: new RfmService(prisma as any), prisma, steps, tx };
    }

    it('rewrites the scores under a per-organization lock, with room for a large store', async () => {
        const { service, prisma, steps } = setup(null);
        await expect(service.compute('org_1')).resolves.toBe(1);
        expect(steps).toEqual(['lock', 'stats', 'delete', 'insert']);
        expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ timeout: 120_000 });
    });

    it('a refresh that waited for another finds the scores fresh and stops', async () => {
        const { service, tx, steps } = setup(new Date(Date.now() - 13 * 3600_000));
        // Stale when checked; fresh once the other refresh released the lock.
        tx.customerRfmScore.findFirst.mockResolvedValueOnce({ computedAt: new Date(Date.now() - 13 * 3600_000) }).mockResolvedValueOnce({ computedAt: new Date() });
        await service.ensureFresh('org_1');
        expect(steps).toEqual(['lock']);
    });
});
