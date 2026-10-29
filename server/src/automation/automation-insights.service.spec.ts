import { AutomationInsightsService } from './automation-insights.service';

describe('AutomationInsightsService.test', () => {
    const prisma = {
        organization: { findUnique: jest.fn(async () => ({ currency: 'INR' })) },
        messageTemplate: { findMany: jest.fn(async () => []) },
    };
    const insights = new AutomationInsightsService(prisma as never);
    const automation = (event: string) => ({
        platform: 'WHATSAPP',
        channelId: null,
        definition: {
            steps: [
                { id: 't', type: 'trigger', config: { channel: 'whatsapp', event } },
                {
                    id: 'c',
                    type: 'condition',
                    config: { match: 'all', rules: [{ field: 'order_payment', op: 'is', key: '', value: 'cod' }] },
                    branches: { yes: [{ id: 'n', type: 'add_note', config: { text: 'COD {{order.name}} for {{order.total}}' } }], no: [] },
                },
            ],
        },
    });

    it('tries an order trigger with a sample cash-on-delivery order', async () => {
        const result = await insights.test('o', automation('order_created'), {});
        expect(result.order).toEqual({ name: '#1001', payment: 'Cash on delivery', total: '₹1,499.00' });
        expect(result.steps.map((s) => s.detail)).toEqual(['The condition is met.', 'Adds a note: COD #1001 for ₹1,499.00']);
    });

    it('tries a prepaid sample order when asked', async () => {
        const result = await insights.test('o', automation('order_created'), { order: 'prepaid' });
        expect(result.order?.payment).toBe('Paid');
        expect(result.steps.map((s) => s.detail)).toEqual(['The condition is not met.']);
    });

    it('has no order for other triggers', async () => {
        const result = await insights.test('o', automation('tag_added'), {});
        expect(result.order).toBeNull();
    });
});

describe('AutomationInsightsService.stats', () => {
    it('counts a played voice message as sent, delivered and read', async () => {
        const count = (n: number) => ({ _count: { _all: n } });
        const prisma = {
            automationRun: { groupBy: jest.fn(async () => []) },
            automationRunStep: { groupBy: jest.fn(async () => []) },
            message: { groupBy: jest.fn(async () => [{ status: 'DELIVERED', ...count(1) }, { status: 'READ', ...count(2) }, { status: 'PLAYED', ...count(3) }]) },
            $queryRaw: jest.fn(async () => []),
        };
        const { messages } = await new AutomationInsightsService(prisma as never).stats({ id: 'a1' });
        expect(messages).toMatchObject({ sent: 6, delivered: 6, read: 5 });
    });
});
