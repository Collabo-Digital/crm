import type { TemplateDraft } from './template-components';

export interface TemplateStarter {
    key: string;
    useCase: 'orders' | 'shipping' | 'payments' | 'recovery' | 'promotions' | 'engagement';
    title: string;
    description: string;
    draft: Omit<TemplateDraft, 'language'>;
}

/// Shown on promotional starters: the reply that records an opt-out (see consent.service.ts).
export const STOP_BUTTON = { type: 'QUICK_REPLY' as const, text: 'Stop promotions' };

/**
 * Starting points for common store messages, written for Collabo. Each is a
 * normal draft: the merchant edits it and submits it to Meta for review.
 */
export const TEMPLATE_STARTERS: TemplateStarter[] = [
    {
        key: 'order_confirmed',
        useCase: 'orders',
        title: 'Order confirmed',
        description: 'Sent when an order is placed, with the order number and total.',
        draft: {
            name: 'order_confirmed',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            header: { format: 'TEXT', text: 'Order received' },
            body: {
                text: 'Hi {{first_name}}, thanks for your order {{order_number}}. We have received {{order_total}} and will let you know as soon as it ships.',
                examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
            },
            footer: 'Reply here if you need help with this order',
        },
    },
    {
        key: 'order_shipped',
        useCase: 'shipping',
        title: 'Order shipped',
        description: 'Tells the customer their parcel is on its way, with a tracking link.',
        draft: {
            name: 'order_shipped',
            category: 'UTILITY',
            parameterFormat: 'POSITIONAL',
            body: {
                text: 'Good news {{1}} — order {{2}} has left our warehouse with {{3}}. Track it with the button below.',
                examples: { 1: 'Ananya', 2: '#1042', 3: 'Delhivery' },
            },
            buttons: [{ type: 'URL', text: 'Track parcel', url: 'https://example.com/track/{{1}}', example: 'AWB123456' }],
        },
    },
    {
        key: 'out_for_delivery',
        useCase: 'shipping',
        title: 'Out for delivery',
        description: 'A heads-up on delivery day so someone is home.',
        draft: {
            name: 'out_for_delivery',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, order {{order_number}} is out for delivery today. Please keep your phone handy for the courier.',
                examples: { first_name: 'Ananya', order_number: '#1042' },
            },
        },
    },
    {
        key: 'invoice_ready',
        useCase: 'orders',
        title: 'GST invoice',
        description: 'Sends the order’s GST invoice as a PDF after the purchase.',
        draft: {
            name: 'invoice_ready',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            header: { format: 'DOCUMENT' },
            body: {
                text: 'Hi {{first_name}}, thank you for your order {{order_number}}. Your GST invoice {{invoice_number}} for {{invoice_total}} is attached.',
                examples: { first_name: 'Ananya', order_number: '#1042', invoice_number: 'INV-26-27/000042', invoice_total: '₹2,499' },
            },
        },
    },
    {
        key: 'cod_confirmation',
        useCase: 'payments',
        title: 'Confirm cash-on-delivery order',
        description: 'Asks the customer to confirm a COD order before it ships.',
        draft: {
            name: 'cod_order_confirmation',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, please confirm your cash-on-delivery order {{order_number}} for {{order_total}} so we can ship it.',
                examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
            },
            buttons: [
                { type: 'QUICK_REPLY', text: 'Confirm order' },
                { type: 'QUICK_REPLY', text: 'Cancel order' },
            ],
        },
    },
    {
        key: 'payment_reminder',
        useCase: 'payments',
        title: 'Payment pending',
        description: 'Reminds the customer to finish paying for an order.',
        draft: {
            name: 'payment_pending',
            category: 'UTILITY',
            parameterFormat: 'POSITIONAL',
            body: {
                text: 'Hi {{1}}, payment for order {{2}} is still pending. You can complete it with the link below.',
                examples: { 1: 'Ananya', 2: '#1042' },
            },
            buttons: [{ type: 'URL', text: 'Pay now', url: 'https://example.com/pay/{{1}}', example: 'ord_1042' }],
        },
    },
    {
        key: 'payment_link',
        useCase: 'payments',
        title: 'Pay for your order',
        description: 'Sends a Razorpay payment link for an order or a cart, from your own Razorpay account.',
        draft: {
            name: 'order_payment_link',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, your order {{order_number}} for {{order_total}} is ready. Pay securely online with the button below.',
                examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
            },
            // Meta lets only the end of a button URL vary; the payment link's path goes there.
            buttons: [{ type: 'URL', text: 'Pay now', url: 'https://rzp.io/{{1}}', example: 'rzp/aBcD1234' }],
        },
    },
    {
        key: 'cod_to_prepaid',
        useCase: 'payments',
        title: 'Pay online instead of cash',
        description: 'Offers a cash-on-delivery buyer to pay online now, with a Razorpay payment link.',
        draft: {
            name: 'cod_pay_online',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, your order {{order_number}} for {{order_total}} is set for cash on delivery. Prefer to pay online now? Use the button below and skip paying cash at the door.',
                examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
            },
            buttons: [{ type: 'URL', text: 'Pay online', url: 'https://rzp.io/{{1}}', example: 'rzp/aBcD1234' }],
        },
    },
    {
        key: 'cart_reminder',
        useCase: 'recovery',
        title: 'Items left in cart',
        description: 'Brings back a shopper who left items in their cart.',
        draft: {
            name: 'cart_reminder',
            category: 'MARKETING',
            parameterFormat: 'POSITIONAL',
            body: {
                text: 'Hi {{1}}, you left a few things in your cart. They are still waiting for you — finish checking out before they sell out.',
                examples: { 1: 'Ananya' },
            },
            footer: 'Tap Stop promotions to opt out',
            // Your store's address, then {{1}}: automations fill in the rest of Shopify's recovery link ({{checkout.url_path}}).
            buttons: [{ type: 'URL', text: 'Return to cart', url: 'https://example.com/{{1}}', example: '12345/checkouts/c8f2a/recover?key=k1' }, STOP_BUTTON],
        },
    },
    {
        key: 'back_in_stock',
        useCase: 'recovery',
        title: 'Back in stock',
        description: 'Lets interested customers know a product is available again.',
        draft: {
            name: 'back_in_stock',
            category: 'MARKETING',
            parameterFormat: 'NAMED',
            header: { format: 'IMAGE' },
            body: {
                text: 'Good news, {{first_name}}: {{product_name}} is back in stock. Sizes go fast — grab yours today.',
                examples: { product_name: 'Linen Kurta', first_name: 'Ananya' },
            },
            footer: 'Tap Stop promotions to opt out',
            buttons: [{ type: 'URL', text: 'Shop now', url: 'https://example.com/products' }, STOP_BUTTON],
        },
    },
    {
        key: 'sale_announcement',
        useCase: 'promotions',
        title: 'Sale announcement',
        description: 'A sale with a coupon the customer can copy in one tap.',
        draft: {
            name: 'sale_announcement',
            category: 'MARKETING',
            parameterFormat: 'POSITIONAL',
            header: { format: 'TEXT', text: 'Our {{1}} is live', example: 'Festive Sale' },
            body: {
                text: 'Hi {{1}}, enjoy {{2}} off everything until {{3}}. Use the code below at checkout.',
                examples: { 1: 'Ananya', 2: '20%', 3: 'Sunday' },
            },
            footer: 'Tap Stop promotions to opt out',
            buttons: [{ type: 'COPY_CODE', example: 'FESTIVE20' }, { type: 'URL', text: 'Shop the sale', url: 'https://example.com/sale' }, STOP_BUTTON],
        },
    },
    {
        key: 'welcome_offer',
        useCase: 'promotions',
        title: 'Welcome offer',
        description: 'Thanks a new subscriber and gives them a first-order discount.',
        draft: {
            name: 'welcome_offer',
            category: 'MARKETING',
            parameterFormat: 'NAMED',
            body: {
                text: 'Welcome, {{first_name}}! Here is {{discount}} off your first order — just use code {{code}} at checkout.',
                examples: { first_name: 'Ananya', discount: '10%', code: 'HELLO10' },
            },
            footer: 'Tap Stop promotions to opt out',
            buttons: [STOP_BUTTON],
        },
    },
    {
        key: 'review_request',
        useCase: 'engagement',
        title: 'Ask for a rating',
        description: 'Asks a customer to rate their delivered order from 1 to 5. The “Collect reviews” automation publishes it to Judge.me.',
        draft: {
            name: 'review_request',
            // Meta: feedback on a specific order, with nothing promotional, can be utility.
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, your order {{order_number}} was delivered. How would you rate it?',
                examples: { first_name: 'Ananya', order_number: '#1042' },
            },
            // Each starts with its rating, which the automation reads.
            buttons: [
                { type: 'QUICK_REPLY', text: '5 - Excellent' },
                { type: 'QUICK_REPLY', text: '4 - Good' },
                { type: 'QUICK_REPLY', text: '3 - Okay' },
                { type: 'QUICK_REPLY', text: '2 - Poor' },
                { type: 'QUICK_REPLY', text: '1 - Very poor' },
            ],
        },
    },
];
