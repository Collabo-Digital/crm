import type { TemplateCategoryName, TemplateDraft } from '../template-components';
import { STOP_BUTTON, billLinkPrefix } from '../template-starters';
import { storeLinkPrefix } from '../../../commerce/store-links';

/**
 * Collabo's recommended WhatsApp templates: the set created on a merchant's
 * WhatsApp Business Account when WhatsApp is connected (core), when Razorpay
 * is connected (payment) and when an online store is connected (online_store).
 *
 * Each slot lists its variants in order of preference. A Meta Template
 * Library variant is approved the moment it is created and is the hardest to
 * move to marketing, so it comes first wherever every one of its parameters
 * maps to data Collabo has; Collabo's own wording follows. Utility wording
 * stays strictly factual: Meta files a utility template that reads as
 * promotional under marketing, and warns, then restricts, accounts that keep
 * doing it, and one bad wording here would be repeated on every merchant's
 * account.
 *
 * `values` maps each template parameter (as templateParams keys it: body.1,
 * body.first_name, button.0, coupon.0) to the automation variables that fill
 * it; `{{name|fallback}}` stands for the fallback when the variable is empty.
 *
 * When a slot's wording or shape changes, raise that slot's `version` and
 * bump TEMPLATE_PACK_VERSION: every account on an older pack is ensured again
 * at start-up, and only the slots without a template at their version are
 * created (`collabo_<slot>_v<version>`). Until Meta approves the new one, the
 * approved older one keeps sending.
 */

export const TEMPLATE_PACK_VERSION = 2;

export type PackSet = 'core' | 'payment' | 'online_store';

export type PackSlotKey =
    | 'order_confirmed'
    | 'cod_confirm'
    | 'order_shipped'
    | 'out_for_delivery'
    | 'order_delivered'
    | 'order_cancelled'
    | 'refund_processed'
    | 'gst_invoice'
    | 'store_bill'
    | 'review_request'
    | 'optin_confirmed'
    | 'payment_link'
    | 'pay_online'
    | 'cart_reminder_1'
    | 'cart_reminder_2'
    | 'cart_reminder_3';

/** A URL input for a library template's link button: a fixed base plus one `{{1}}` suffix. */
export interface LibraryButtonInput {
    type: 'URL';
    url: { base_url: string; url_suffix_example: string };
}

export interface LibraryVariant {
    source: 'library';
    /** Meta's library template name; created with `library_template_name`. */
    libraryTemplateName: string;
    /** Meta's library wording, for previews and for tests; Meta owns the real text. */
    preview: { header?: string; body: string; buttons?: string[] };
    buttonInputs?: LibraryButtonInput[];
    values: Record<string, string>;
}

export interface CollaboVariant {
    source: 'collabo';
    draft: Omit<TemplateDraft, 'name' | 'language' | 'category'>;
    values: Record<string, string>;
    /** Quick-reply payloads sent with the template, by button index, so replies are matched on the payload, not the label. */
    quickReplyPayloads?: Record<number, string>;
}

export type PackVariant = LibraryVariant | CollaboVariant;

export interface PackSlot {
    key: PackSlotKey;
    set: PackSet;
    category: TemplateCategoryName;
    title: string;
    description: string;
    /** The slot's wording and shape: a template made at an older version is replaced by one at this. 1 when not given. */
    version?: number;
    /** A document header that is the order's GST invoice PDF at send time; created with a sample PDF. */
    invoiceDocument?: boolean;
    /**
     * A document header the till fills with the sale's bill PDF at send time
     * (pos-bill.service.ts); created with a sample PDF. Automations never
     * send it: they have no sale to bill.
     */
    tillDocument?: boolean;
    variants: PackVariant[];
}

export const slotVersion = (slot: Pick<PackSlot, 'version'>): number => slot.version ?? 1;

/** Every pack template is English for now. */
export const PACK_LANGUAGE = 'en';

/** `collabo_order_confirmed_v1`: a prefix no starter or merchant template uses, and a version a replacement moves past. */
export function packTemplateName(slot: PackSlotKey, version: number): string {
    return `collabo_${slot}_v${version}`;
}

/** Payloads of the COD confirmation's quick replies. */
export const COD_CONFIRM_PAYLOAD = 'collabo_cod_confirm';
export const COD_CANCEL_PAYLOAD = 'collabo_cod_cancel';

const TOKEN_EXAMPLE = 'cm3x8k2p40000qz7w1rbt9e4d.Zq1v7Xc9QmJ4rT2yLw8sNa';
const FIRST_NAME = '{{first_name|there}}';

/**
 * The pack, with link buttons on `frontendUrl` (the app's own address: bills,
 * order tracking and carts open there). Razorpay buttons stay on rzp.io:
 * WhatsApp shows them as a payment card only when they are not redirected.
 */
export function templatePack(frontendUrl: string): PackSlot[] {
    const track = `${storeLinkPrefix(frontendUrl, 'order')}{{1}}`;
    const cart = `${storeLinkPrefix(frontendUrl, 'cart')}{{1}}`;
    return [
        {
            key: 'order_confirmed',
            set: 'core',
            category: 'UTILITY',
            title: 'Order confirmed',
            description: 'Sent when a prepaid order is placed, or when the customer confirms a cash-on-delivery order.',
            variants: [
                {
                    source: 'library',
                    libraryTemplateName: 'order_confirmed',
                    preview: { header: 'Order confirmed', body: "Hi {{1}}, We're getting your order {{2}} ready and will let you know when it's on the way." },
                    values: { 'body.1': FIRST_NAME, 'body.2': '{{order.name}}' },
                },
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        header: { format: 'TEXT', text: 'Order confirmed' },
                        body: {
                            text: 'Hi {{first_name}}, thank you for your order {{order_number}} of {{order_total}}. We are getting it ready and will message you here when it ships.',
                            examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
                        },
                        footer: 'Reply to this message if you need help',
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}', 'body.order_total': '{{order.total}}' },
                },
            ],
        },
        {
            key: 'cod_confirm',
            set: 'core',
            category: 'UTILITY',
            title: 'Confirm a cash-on-delivery order',
            description: 'Asks the customer to confirm or cancel a cash-on-delivery order before it ships.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        header: { format: 'TEXT', text: 'Please confirm your order' },
                        body: {
                            text: 'Hi {{first_name}}, you placed a cash-on-delivery order {{order_number}} for {{order_total}}. Please confirm it so we can ship it, or cancel it if you no longer need it.',
                            examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
                        },
                        buttons: [
                            { type: 'QUICK_REPLY', text: 'Confirm order' },
                            { type: 'QUICK_REPLY', text: 'Cancel order' },
                        ],
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}', 'body.order_total': '{{order.total}}' },
                    quickReplyPayloads: { 0: COD_CONFIRM_PAYLOAD, 1: COD_CANCEL_PAYLOAD },
                },
            ],
        },
        {
            key: 'order_shipped',
            set: 'core',
            category: 'UTILITY',
            title: 'Order shipped',
            description: 'Sent when an order ships, with a button to track the parcel.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} has been shipped with {{carrier}}. You can follow the parcel with the button below.',
                            examples: { first_name: 'Ananya', order_number: '#1042', carrier: 'Delhivery' },
                        },
                        buttons: [{ type: 'URL', text: 'Track order', url: track, example: TOKEN_EXAMPLE }],
                    },
                    values: {
                        'body.first_name': FIRST_NAME,
                        'body.order_number': '{{order.name}}',
                        'body.carrier': '{{order.carrier|our delivery partner}}',
                        'button.0': '{{order.track_path}}',
                    },
                },
                {
                    source: 'library',
                    libraryTemplateName: 'order_shipped',
                    preview: { header: 'Order shipped', body: 'Hi {{1}}, Your order {{2}} has been shipped and is on the way.' },
                    values: { 'body.1': FIRST_NAME, 'body.2': '{{order.name}}' },
                },
            ],
        },
        {
            key: 'out_for_delivery',
            set: 'core',
            category: 'UTILITY',
            title: 'Out for delivery',
            description: 'Sent when the courier reports the order out for delivery.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} is out for delivery today. Please keep your phone reachable so the delivery partner can contact you.',
                            examples: { first_name: 'Ananya', order_number: '#1042' },
                        },
                        buttons: [{ type: 'URL', text: 'Track order', url: track, example: TOKEN_EXAMPLE }],
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}', 'button.0': '{{order.track_path}}' },
                },
            ],
        },
        {
            key: 'order_delivered',
            set: 'core',
            category: 'UTILITY',
            title: 'Order delivered',
            description: 'Sent when the order is delivered.',
            variants: [
                {
                    source: 'library',
                    libraryTemplateName: 'order_delivered',
                    preview: { header: 'Order delivered', body: 'Hi {{1}}, Your {{2}} has been delivered. Thank you for shopping with us.' },
                    values: { 'body.1': FIRST_NAME, 'body.2': 'order {{order.name}}' },
                },
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} has been delivered. If anything is missing or damaged, reply to this message and we will sort it out.',
                            examples: { first_name: 'Ananya', order_number: '#1042' },
                        },
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}' },
                },
            ],
        },
        {
            key: 'order_cancelled',
            set: 'core',
            category: 'UTILITY',
            title: 'Order cancelled',
            description: 'Sent when an order is cancelled.',
            variants: [
                {
                    source: 'library',
                    libraryTemplateName: 'order_canceled_3',
                    preview: {
                        body: 'Hi, this is to confirm we have successfully canceled your recent order {{1}}. Thank you.',
                        buttons: ['View order details'],
                    },
                    buttonInputs: [{ type: 'URL', url: { base_url: track, url_suffix_example: `${storeLinkPrefix(frontendUrl, 'order')}${TOKEN_EXAMPLE}` } }],
                    values: { 'body.1': '{{order.name}}', 'button.0': '{{order.track_path}}' },
                },
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} has been cancelled. If you already paid for it, we will message you here once the refund is processed.',
                            examples: { first_name: 'Ananya', order_number: '#1042' },
                        },
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}' },
                },
            ],
        },
        {
            key: 'refund_processed',
            set: 'core',
            category: 'UTILITY',
            title: 'Refund processed',
            description: 'Sent when a refund is issued for an order.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, we have processed a refund of {{refund_amount}} for your order {{order_number}}. Depending on your bank, it can take a few working days to reach your account.',
                            examples: { first_name: 'Ananya', refund_amount: '₹2,499', order_number: '#1042' },
                        },
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.refund_amount': '{{refund.amount}}', 'body.order_number': '{{order.name}}' },
                },
            ],
        },
        {
            key: 'gst_invoice',
            set: 'core',
            category: 'UTILITY',
            title: 'GST invoice',
            description: "Sends the order's GST invoice as a PDF when it is issued.",
            invoiceDocument: true,
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        header: { format: 'DOCUMENT' },
                        body: {
                            text: 'Hi {{first_name}}, thank you for your order {{order_number}}. Your GST invoice {{invoice_number}} for {{invoice_total}} is attached to this message. Please keep it for your records.',
                            examples: { first_name: 'Ananya', order_number: '#1042', invoice_number: 'INV-26-27/000042', invoice_total: '₹2,499' },
                        },
                        footer: 'Reply here if you need help with this invoice',
                    },
                    values: {
                        'body.first_name': FIRST_NAME,
                        'body.order_number': '{{order.name}}',
                        'body.invoice_number': '{{invoice.number}}',
                        'body.invoice_total': '{{invoice.total}}',
                    },
                },
            ],
        },
        {
            key: 'store_bill',
            set: 'core',
            category: 'UTILITY',
            title: 'Bill from the till',
            description: 'The bill the point of sale sends a walk-in customer, as a PDF with a link to view or download it.',
            // 2: the bill's PDF in a document header.
            version: 2,
            tillDocument: true,
            variants: [
                {
                    // The till fills these five by name (pos-bill-template.ts): keep the names.
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        header: { format: 'DOCUMENT' },
                        body: {
                            text: 'Hi {{first_name}}, thank you for shopping at {{store_name}}. Your bill {{bill_number}} for {{bill_total}}, dated {{bill_date}}, is ready. Tap View bill below to see or download it.',
                            examples: { first_name: 'Ananya', store_name: 'Acme Store', bill_number: 'INV-26-27/000123', bill_total: '₹2,340.00', bill_date: '26 Oct 2026' },
                        },
                        footer: 'Reply here if you need help with your bill',
                        buttons: [{ type: 'URL', text: 'View bill', url: `${billLinkPrefix(frontendUrl)}{{1}}`, example: TOKEN_EXAMPLE }],
                    },
                    values: {},
                },
            ],
        },
        {
            key: 'review_request',
            set: 'core',
            category: 'UTILITY',
            title: 'Review request',
            description: 'Asks for a rating two days after delivery. Off until you turn it on.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} was delivered. How would you rate it?',
                            examples: { first_name: 'Ananya', order_number: '#1042' },
                        },
                        buttons: [
                            { type: 'QUICK_REPLY', text: '5 - Excellent' },
                            { type: 'QUICK_REPLY', text: '4 - Good' },
                            { type: 'QUICK_REPLY', text: '3 - Okay' },
                            { type: 'QUICK_REPLY', text: '2 - Poor' },
                            { type: 'QUICK_REPLY', text: '1 - Very poor' },
                        ],
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.order_number': '{{order.name}}' },
                },
            ],
        },
        {
            key: 'optin_confirmed',
            set: 'core',
            category: 'UTILITY',
            title: 'Subscription confirmed',
            description: 'Confirms a sign-up for WhatsApp updates from your website.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, thanks for subscribing to WhatsApp updates from {{store_name}}. You will get your order updates in this chat.',
                            examples: { first_name: 'Ananya', store_name: 'Acme Store' },
                        },
                        buttons: [STOP_BUTTON],
                    },
                    values: { 'body.first_name': FIRST_NAME, 'body.store_name': '{{store.name}}' },
                },
            ],
        },
        {
            key: 'payment_link',
            set: 'payment',
            category: 'UTILITY',
            title: 'Payment link',
            description: 'Sends a Razorpay link to pay for an order.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} for {{order_total}} is ready. You can pay securely with the button below.',
                            examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
                        },
                        buttons: [{ type: 'URL', text: 'Pay now', url: 'https://rzp.io/{{1}}', example: 'rzp/aBcD1234' }],
                    },
                    values: {
                        'body.first_name': FIRST_NAME,
                        'body.order_number': '{{order.name}}',
                        'body.order_total': '{{order.total}}',
                        'button.0': '{{payment.link_path}}',
                    },
                },
            ],
        },
        {
            key: 'pay_online',
            set: 'payment',
            category: 'UTILITY',
            title: 'Pay online for a COD order',
            description: 'Offers a confirmed cash-on-delivery order the option to pay online now.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your order {{order_number}} for {{order_total}} is set to cash on delivery. If you prefer to pay online, you can pay now with the button below. Otherwise, please keep the amount ready at delivery.',
                            examples: { first_name: 'Ananya', order_number: '#1042', order_total: '₹2,499' },
                        },
                        buttons: [{ type: 'URL', text: 'Pay online', url: 'https://rzp.io/{{1}}', example: 'rzp/aBcD1234' }],
                    },
                    values: {
                        'body.first_name': FIRST_NAME,
                        'body.order_number': '{{order.name}}',
                        'body.order_total': '{{order.total}}',
                        'button.0': '{{payment.link_path}}',
                    },
                },
            ],
        },
        {
            key: 'cart_reminder_1',
            set: 'online_store',
            category: 'MARKETING',
            title: 'Cart reminder 1',
            description: 'Sent 30 minutes after a shopper leaves checkout.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        header: { format: 'TEXT', text: 'Your cart is saved' },
                        body: {
                            text: 'Hi {{first_name}}, you left {{cart_items}} in your cart. Your total is {{cart_total}}. Tap below to finish your order in a few seconds.',
                            examples: { first_name: 'Ananya', cart_items: 'Linen kurta × 2', cart_total: '₹2,499' },
                        },
                        footer: 'Tap Stop promotions to opt out',
                        buttons: [{ type: 'URL', text: 'Return to cart', url: cart, example: TOKEN_EXAMPLE }, STOP_BUTTON],
                    },
                    values: {
                        'body.first_name': '{{first_name|there}}',
                        'body.cart_items': '{{checkout.items}}',
                        'body.cart_total': '{{checkout.total}}',
                        'button.0': '{{checkout.cart_path}}',
                    },
                },
            ],
        },
        {
            key: 'cart_reminder_2',
            set: 'online_store',
            category: 'MARKETING',
            title: 'Cart reminder 2',
            description: 'Sent 4 hours after the first reminder if the shopper has not ordered or replied.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, your cart is still saved for you. If you have a question about sizes, delivery or payment, just reply here. You can complete your order with the button below.',
                            examples: { first_name: 'Ananya' },
                        },
                        footer: 'Tap Stop promotions to opt out',
                        buttons: [{ type: 'URL', text: 'Return to cart', url: cart, example: TOKEN_EXAMPLE }, STOP_BUTTON],
                    },
                    values: { 'body.first_name': '{{first_name|there}}', 'button.0': '{{checkout.cart_path}}' },
                },
            ],
        },
        {
            key: 'cart_reminder_3',
            set: 'online_store',
            category: 'MARKETING',
            title: 'Cart reminder 3 (with a discount)',
            description: 'Sent a day after the first reminder, only when you have set a discount code for it.',
            variants: [
                {
                    source: 'collabo',
                    draft: {
                        parameterFormat: 'NAMED',
                        body: {
                            text: 'Hi {{first_name}}, here is {{discount}} off to complete your order. The code is valid until {{expiry}}, so use it at checkout soon.',
                            examples: { first_name: 'Ananya', discount: '₹200', expiry: '30 Oct 2026' },
                        },
                        footer: 'Tap Stop promotions to opt out',
                        // Quick replies last: Meta wants them grouped.
                        buttons: [
                            { type: 'COPY_CODE', example: 'SAVE200' },
                            { type: 'URL', text: 'Complete order', url: cart, example: TOKEN_EXAMPLE },
                            STOP_BUTTON,
                        ],
                    },
                    values: {
                        'body.first_name': '{{first_name|there}}',
                        'body.discount': '{{cart.discount_text}}',
                        'body.expiry': '{{cart.discount_expiry}}',
                        'coupon.0': '{{cart.discount_code}}',
                        'button.1': '{{checkout.cart_path}}',
                    },
                },
            ],
        },
    ];
}

/** The slot, or undefined for a key no longer in the pack. */
export function packSlot(frontendUrl: string, key: string): PackSlot | undefined {
    return templatePack(frontendUrl).find((s) => s.key === key);
}

/** The variant a created template came from: its library template, or Collabo's wording. */
export function packVariantOf(
    slot: PackSlot,
    template: { packSource: string | null; libraryTemplateName: string | null },
): PackVariant | undefined {
    return template.packSource === 'library'
        ? slot.variants.find((v) => v.source === 'library' && v.libraryTemplateName === template.libraryTemplateName)
        : slot.variants.find((v) => v.source === 'collabo');
}
