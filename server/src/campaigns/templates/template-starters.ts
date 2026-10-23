import type { TemplateDraft } from './template-components';

export interface TemplateStarter {
    key: string;
    useCase: 'orders' | 'shipping' | 'payments' | 'recovery' | 'promotions' | 'engagement';
    title: string;
    description: string;
    draft: Omit<TemplateDraft, 'language'>;
}

/// Shown on promotional starters: the reply that records an opt-out (see consent.service.ts).
const STOP_BUTTON = { type: 'QUICK_REPLY' as const, text: 'Stop promotions' };

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
                text: '{{product_name}} is back in stock, {{first_name}}. Sizes go fast — grab yours today.',
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
        title: 'Ask for a review',
        description: 'Asks a customer how their order went a few days after delivery.',
        draft: {
            name: 'review_request',
            category: 'MARKETING',
            parameterFormat: 'NAMED',
            body: {
                text: 'Hi {{first_name}}, how are you liking your order {{order_number}}? A quick rating helps us and other shoppers.',
                examples: { first_name: 'Ananya', order_number: '#1042' },
            },
            buttons: [
                { type: 'QUICK_REPLY', text: 'Loved it' },
                { type: 'QUICK_REPLY', text: 'It was okay' },
                { type: 'QUICK_REPLY', text: 'Not happy' },
            ],
        },
    },
];
