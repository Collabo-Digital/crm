export const WHATSAPP_MESSAGING_QUEUE = 'whatsapp-messaging';

/**
 * Job payload for a single outbound WhatsApp template send.
 * Consumed by WhatsAppMessagingProcessor. No longer enqueued (see the processor).
 */
export interface WhatsAppMessageJobData {
    organizationId: string;
    channelId: string;
    customerId?: string;
    orderId?: string;
    /** E.164 normalized phone (e.g., "+919876543210") */
    toPhone: string;
    /** WhatsApp template name registered in the merchant's WABA. MVP uses "hello_world". */
    templateName: string;
    /** e.g., "en_US" */
    templateLanguage: string;
    /** Human-readable label for why this was triggered, e.g., "order_placed". */
    triggerType: string;
}
