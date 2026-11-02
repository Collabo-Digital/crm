import { AdsService } from './ads.service';

describe('Ads page totals', () => {
    it('count an order once, though each ad the customer came from is credited with it', async () => {
        const at = new Date('2026-10-20T10:00:00Z');
        const prisma = {
            organization: { findUniqueOrThrow: jest.fn(async () => ({ timezone: 'Asia/Kolkata', currency: 'INR' })) },
            $queryRaw: jest
                .fn()
                .mockResolvedValueOnce([
                    { ad_id: 'ad_a', headline: 'A', platform: 'WHATSAPP', chats: 1, last_at: at },
                    { ad_id: 'ad_b', headline: 'B', platform: 'WHATSAPP', chats: 1, last_at: at },
                ])
                // One ₹2,000 order from a customer who chatted from both ads.
                .mockResolvedValueOnce([
                    { ad_id: 'ad_a', orders: 1, revenue: 2000 },
                    { ad_id: 'ad_b', orders: 1, revenue: 2000 },
                    { ad_id: null, orders: 1, revenue: 2000 },
                ]),
            adAccount: { findUnique: jest.fn(async () => null) },
        };
        const config = { get: () => undefined };
        const service = new AdsService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, config as any);
        const report = await service.report('org_1', 30);
        expect(report.ads.map((a) => [a.adId, a.orders, a.revenue])).toEqual([
            ['ad_a', 1, 2000],
            ['ad_b', 1, 2000],
        ]);
        expect(report.totals).toEqual({ chats: 2, orders: 1, revenue: 2000, spend: null });
    });
});
