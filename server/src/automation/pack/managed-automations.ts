import { isDeepStrictEqual } from 'node:util';
import { COD_CANCEL_PAYLOAD, COD_CONFIRM_PAYLOAD, type PackSet, type PackSlotKey } from '../../campaigns/templates/pack/template-pack';
import { parseDefinition, type StepDef } from '../blocks/definition.schema';
import { Flow } from '../engine/flow';
import type { CartDiscount } from './cart-discount';

/**
 * The automations that send Collabo's recommended templates. Each is created
 * as a draft when its set applies to the organization (see
 * ManagedAutomationsService) and goes live once every template it sends is
 * approved. Steps name a pack slot, never a template, so a replacement version
 * of a template is picked up without editing anything.
 *
 * Step ids are fixed: a stored definition equal to one the registry builds is
 * still Collabo's, and anything else is the merchant's own edit, which is
 * never touched.
 */

export interface PackSettings {
    cartDiscount: CartDiscount | null;
}

export interface ManagedAutomation {
    packKey: string;
    name: string;
    description: string;
    set: PackSet;
    /** Goes live by itself on accounts that connected WhatsApp after the pack shipped. */
    defaultOn: boolean;
    /** The definition for the pack's settings now. */
    steps(settings: PackSettings): StepDef[];
}

const trigger = (event: string, extra: Record<string, unknown> = {}): StepDef => ({
    id: 'pk_trigger',
    type: 'trigger',
    config: { channel: 'whatsapp', event, skipPos: true, ...extra },
});
const send = (id: string, slot: PackSlotKey): StepDef => ({ id, type: 'send_message', config: { kind: 'template', templateSlot: slot } });
const wait = (id: string, amount: number, unit: 'hours' | 'days'): StepDef => ({ id, type: 'wait', config: { amount, unit } });
const payment = (id: string, value: 'cod' | 'prepaid', yes: StepDef[]): StepDef => ({
    id,
    type: 'condition',
    config: { match: 'all', rules: [{ field: 'order_payment', op: 'is', value }] },
    branches: { yes, no: [] },
});

const CONFIRM_WORDS = 'confirm order, confirm, yes';
const CANCEL_WORDS = 'cancel order, cancel, cancel my order';

/**
 * A reply to the COD question, matched on the tapped button's payload and,
 * for a typed answer or a template sent before payloads, on its words.
 * Anything else ("when will it arrive?") tags the order cod-check for the
 * team. The three are checked one after the other, not nested: with the
 * resend this keeps the flow within four levels of branching.
 */
const codReplies = (n: number): StepDef[] => [
    {
        id: `pk_confirmed_${n}`,
        type: 'condition',
        config: {
            match: 'any',
            rules: [
                { field: 'reply_payload', op: 'equals', value: COD_CONFIRM_PAYLOAD },
                { field: 'last_reply', op: 'equals', value: CONFIRM_WORDS },
            ],
        },
        branches: {
            yes: [{ id: `pk_tag_confirmed_${n}`, type: 'store_action', config: { action: 'tag_order', value: 'cod-confirmed' } }, send(`pk_order_confirmed_${n}`, 'order_confirmed')],
            no: [],
        },
    },
    {
        id: `pk_cancelled_${n}`,
        type: 'condition',
        config: {
            match: 'any',
            rules: [
                { field: 'reply_payload', op: 'equals', value: COD_CANCEL_PAYLOAD },
                { field: 'last_reply', op: 'equals', value: CANCEL_WORDS },
            ],
        },
        branches: {
            yes: [{ id: `pk_cancel_${n}`, type: 'store_action', config: { action: 'cancel_order', value: 'The customer cancelled it on WhatsApp.' } }],
            no: [],
        },
    },
    {
        id: `pk_unclear_${n}`,
        type: 'condition',
        config: {
            match: 'all',
            rules: [
                { field: 'reply_payload', op: 'is_not', value: `${COD_CONFIRM_PAYLOAD}, ${COD_CANCEL_PAYLOAD}` },
                { field: 'last_reply', op: 'is_not', value: `${CONFIRM_WORDS}, ${CANCEL_WORDS}` },
            ],
        },
        branches: {
            yes: [{ id: `pk_tag_check_${n}`, type: 'store_action', config: { action: 'tag_order', value: 'cod-check' } }],
            no: [],
        },
    },
];

export const MANAGED_AUTOMATIONS: ManagedAutomation[] = [
    {
        packKey: 'order_confirmed',
        name: 'Order confirmed',
        description: 'Thanks the customer when a prepaid order is placed.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_created'), payment('pk_prepaid', 'prepaid', [send('pk_send', 'order_confirmed')])],
    },
    {
        packKey: 'cod_confirmation',
        name: 'Confirm cash-on-delivery orders',
        description: 'Asks the customer to confirm a cash-on-delivery order, asks again after 3 hours, cancels the order if they tap Cancel, and tags it cod-check for your team when they answer anything else.',
        set: 'core',
        defaultOn: true,
        steps: () => [
            trigger('order_created'),
            payment('pk_cod', 'cod', [
                send('pk_ask', 'cod_confirm'),
                {
                    id: 'pk_reply',
                    type: 'wait_for_reply',
                    config: { amount: 3, unit: 'hours' },
                    branches: {
                        replied: codReplies(1),
                        timeout: [
                            send('pk_ask_again', 'cod_confirm'),
                            {
                                id: 'pk_reply_again',
                                type: 'wait_for_reply',
                                config: { amount: 21, unit: 'hours' },
                                branches: {
                                    replied: codReplies(2),
                                    timeout: [{ id: 'pk_unconfirmed', type: 'store_action', config: { action: 'tag_order', value: 'cod-unconfirmed' } }],
                                },
                            },
                        ],
                    },
                },
            ]),
        ],
    },
    {
        packKey: 'order_shipped',
        name: 'Order shipped',
        description: 'Tells the customer their order has shipped, with a button to track it.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_fulfilled', { skipWhatsAppPay: true }), send('pk_send', 'order_shipped')],
    },
    {
        packKey: 'out_for_delivery',
        name: 'Out for delivery',
        description: 'Tells the customer when the courier is out to deliver their order.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_out_for_delivery', { skipWhatsAppPay: true }), send('pk_send', 'out_for_delivery')],
    },
    {
        packKey: 'order_delivered',
        name: 'Order delivered',
        description: 'Tells the customer their order was delivered.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_delivered', { skipWhatsAppPay: true }), send('pk_send', 'order_delivered')],
    },
    {
        packKey: 'order_cancelled',
        name: 'Order cancelled',
        description: 'Tells the customer when an order is cancelled.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_cancelled', { skipWhatsAppPay: true }), send('pk_send', 'order_cancelled')],
    },
    {
        packKey: 'refund_processed',
        name: 'Refund processed',
        description: 'Tells the customer when a refund is issued, with the amount.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('order_refunded'), send('pk_send', 'refund_processed')],
    },
    {
        packKey: 'gst_invoice',
        name: 'GST invoice',
        description: 'Sends the GST invoice as a PDF when it is issued, for orders placed in the last 3 days.',
        set: 'core',
        defaultOn: true,
        // Invoicing old orders in bulk must not message their buyers.
        steps: () => [trigger('invoice_issued', { orderWithinDays: 3 }), send('pk_send', 'gst_invoice')],
    },
    {
        packKey: 'review_request',
        name: 'Review request',
        description: 'Asks for a rating two days after delivery.',
        set: 'core',
        defaultOn: false,
        steps: () => [trigger('order_delivered'), wait('pk_wait', 2, 'days'), send('pk_send', 'review_request')],
    },
    {
        packKey: 'optin_confirmed',
        name: 'Subscription confirmed',
        description: 'Confirms a sign-up for WhatsApp updates from your website.',
        set: 'core',
        defaultOn: true,
        steps: () => [trigger('website_signup'), send('pk_send', 'optin_confirmed')],
    },
    {
        packKey: 'cart_recovery',
        name: 'Cart recovery',
        description: 'Reminds a shopper 30 minutes after they leave checkout and again 4 hours later, with your discount a day later if you set one. Stops when they order, reply or opt out.',
        set: 'online_store',
        defaultOn: true,
        steps: ({ cartDiscount }) => [
            // One reminder sequence per shopper at a time: a second checkout left meanwhile is skipped.
            trigger('checkout_abandoned', { stopWhen: { orderPlaced: true, replied: true, optedOut: true }, oneRunAtATime: true }),
            send('pk_reminder_1', 'cart_reminder_1'),
            wait('pk_wait_1', 4, 'hours'),
            send('pk_reminder_2', 'cart_reminder_2'),
            ...(cartDiscount ? [wait('pk_wait_2', 20, 'hours'), send('pk_reminder_3', 'cart_reminder_3')] : []),
        ],
    },
];

export const MANAGED_BY_KEY = new Map(MANAGED_AUTOMATIONS.map((m) => [m.packKey, m]));

/** Every definition the registry can build for an automation, whatever the settings. */
function buildsOf(entry: ManagedAutomation): StepDef[][] {
    const discount = { code: 'X', text: 'X', validDays: 1 };
    return [entry.steps({ cartDiscount: null }), entry.steps({ cartDiscount: discount })];
}

/**
 * Whether a stored definition is the registry's: the one these settings
 * build ('current'), one other settings build ('stale': rebuild it), or
 * neither ('edited': the merchant changed it, so it is theirs now).
 */
export function registryMatch(entry: ManagedAutomation, stored: unknown, settings: PackSettings): 'current' | 'stale' | 'edited' {
    let steps: StepDef[];
    try {
        steps = parseDefinition(stored);
    } catch {
        return 'edited';
    }
    const same = (built: StepDef[]) => isDeepStrictEqual(steps, parseDefinition({ steps: built }));
    if (same(entry.steps(settings))) return 'current';
    return buildsOf(entry).some(same) ? 'stale' : 'edited';
}

/** The pack slots a definition sends, in order. A step with a template of its own sends that one instead. */
export function templateSlotsIn(steps: StepDef[]): string[] {
    const slots = new Flow(steps)
        .all()
        .map(({ step }) => step.config)
        .filter((c) => typeof c.templateSlot === 'string' && c.templateSlot && !c.templateId)
        .map((c) => c.templateSlot as string);
    return [...new Set(slots)];
}
