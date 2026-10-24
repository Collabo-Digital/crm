import { checkoutVars, isCashOnDelivery, itemsSummary, orderVars } from './order-vars';

describe('order variables', () => {
    it('recognise cash on delivery by Shopify’s gateway names', () => {
        expect(isCashOnDelivery(['Cash on Delivery (COD)'])).toBe(true);
        expect(isCashOnDelivery(['cod'])).toBe(true);
        expect(isCashOnDelivery(['razorpay', 'shopify_payments'])).toBe(false);
    });

    it('give templates readable values', () => {
        const v = orderVars({
            name: '#1042',
            totalPrice: '2398.5',
            currency: 'INR',
            financialStatus: 'PENDING',
            fulfillmentStatus: 'FULFILLED',
            paymentGateways: ['Cash on Delivery (COD)'],
            lineItems: [{ title: 'Linen shirt', quantity: 2 }, { title: 'Belt', quantity: 1 }],
            fulfillments: [{ trackingNumber: 'AWB1', trackingUrl: 'https://t.example/AWB1', trackingCompany: 'Delhivery' }],
        });
        expect(v).toMatchObject({
            'order.name': '#1042',
            'order.total': '₹2,398.50',
            'order.items': 'Linen shirt × 2, Belt',
            'order.payment': 'Cash on delivery',
            'order.status': 'Shipped',
            'order.tracking_url': 'https://t.example/AWB1',
            'order.carrier': 'Delhivery',
        });
        expect(checkoutVars({ recoveryUrl: 'https://s.example/12345/checkouts/b19/recover?key=abc', total: 999, currency: 'INR', items: [{ title: 'Cap', quantity: 1 }], firstName: ' Riya ' })).toEqual({
            'checkout.first_name': 'Riya',
            'checkout.url': 'https://s.example/12345/checkouts/b19/recover?key=abc',
            'checkout.url_path': '12345/checkouts/b19/recover?key=abc',
            'checkout.total': '₹999.00',
            'checkout.items': 'Cap',
        });
        expect(itemsSummary([{ title: 'x'.repeat(300), quantity: 1 }]).length).toBe(200);
    });
});
