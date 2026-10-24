import { StoreActionsService } from './store-actions.service';

describe('StoreActionsService.cancelOrder', () => {
    function service(order: Record<string, unknown> | null) {
        const prisma = { order: { findFirst: jest.fn(async () => order) } };
        const orders = { cancel: jest.fn(async () => ({})) };
        const none = {} as never;
        return { s: new StoreActionsService(prisma as never, orders as never, none, none, none, none, none), orders };
    }
    const order = (over: Record<string, unknown> = {}) => ({
        cancelledAt: null,
        financialStatus: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
        fulfillments: [],
        ...over,
    });

    it('cancels an unpaid order that has not shipped, without a refund', async () => {
        const { s, orders } = service(order());
        await expect(s.cancelOrder('o', 'ord', 'u', 'Customer declined')).resolves.toBeNull();
        expect(orders.cancel).toHaveBeenCalledWith('ord', 'o', 'u', expect.objectContaining({ refund: false, restock: true, staffNote: 'Customer declined' }));
    });

    it.each(['PAID', 'PARTIALLY_PAID', 'AUTHORIZED', 'PARTIALLY_REFUNDED'])('leaves a %s order alone and says why', async (financialStatus) => {
        const { s, orders } = service(order({ financialStatus }));
        await expect(s.cancelOrder('o', 'ord', 'u', '')).resolves.toMatch(/paid/);
        expect(orders.cancel).not.toHaveBeenCalled();
    });

    it('leaves a shipped or partly shipped order alone', async () => {
        for (const over of [{ fulfillmentStatus: 'FULFILLED' }, { fulfillmentStatus: 'PARTIAL' }, { fulfillments: [{ id: 'f1' }] }]) {
            const { s, orders } = service(order(over));
            await expect(s.cancelOrder('o', 'ord', 'u', '')).resolves.toMatch(/shipped/);
            expect(orders.cancel).not.toHaveBeenCalled();
        }
    });

    it('does nothing for an order already cancelled, or refunded in full', async () => {
        const cancelled = service(order({ cancelledAt: new Date(), financialStatus: 'PAID' }));
        await expect(cancelled.s.cancelOrder('o', 'ord', 'u', '')).resolves.toBeNull();
        expect(cancelled.orders.cancel).not.toHaveBeenCalled();
        const refunded = service(order({ financialStatus: 'REFUNDED' }));
        await expect(refunded.s.cancelOrder('o', 'ord', 'u', '')).resolves.toBeNull();
        expect(refunded.orders.cancel).toHaveBeenCalled();
    });
});
