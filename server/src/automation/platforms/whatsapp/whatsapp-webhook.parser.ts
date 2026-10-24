/**
 * Pure translation of a WhatsApp Business Account webhook delivery into typed
 * events. No DB, no side effects; specced against Meta's documented payloads
 * in test/fixtures/meta/wa-*.json.
 *
 * Identity: since April 2026 every webhook carries a business-scoped user id
 * (BSUID, `user_id`), while the phone number (`wa_id` / `from` / `to`) is
 * omitted for users who adopted a WhatsApp username and have not shared it.
 * Both are surfaced; neither is assumed present.
 */

export interface WaContactRef {
    /** Business-scoped user id, e.g. "US.13491208655302741918". */
    userId: string | null;
    /** Phone number digits. Absent for username adopters who have not shared it. */
    waId: string | null;
    username: string | null;
    profileName: string | null;
}

export interface WaError {
    code: number | null;
    title: string | null;
    message: string | null;
    details: string | null;
}

export interface WaMessage {
    /** wamid — the dedupe key with the channel. */
    id: string;
    timestamp: Date;
    /** text | image | interactive | ... | unsupported | system | edit | revoke | media_placeholder */
    type: string;
    /** The customer, for messages they sent. Null when the business sent it. */
    from: WaContactRef | null;
    /** The customer, for messages the business sent (echoes, history). */
    to: WaContactRef | null;
    /** Plain text for previews and keyword matching, when the type has any. */
    text: string | null;
    /** The message this one replies to or reacts on. */
    context: { from: string | null; id: string | null } | null;
    /** Click-to-WhatsApp ad referral, when the chat started from an ad. */
    referral: Record<string, unknown> | null;
    errors: WaError[];
    /** History only: the message's state on the device at sync time. */
    historyStatus: string | null;
    /** The WhatsApp group it was sent in; `from` is then the participant. */
    groupId: string | null;
    raw: Record<string, unknown>;
}

export interface WaStatus {
    /** wamid of the outbound message this status is about. */
    messageId: string;
    status: 'sent' | 'delivered' | 'read' | 'played' | 'failed' | string;
    timestamp: Date;
    recipient: WaContactRef;
    pricing: { type: string | null; category: string | null; billable: boolean | null } | null;
    errors: WaError[];
    bizOpaqueCallbackData: string | null;
    /** A message sent to a group: the group, and the participant this status is about. */
    groupId: string | null;
    participant: string | null;
    raw: Record<string, unknown>;
}

/** One entry of a groups webhook (`value.groups[]`). */
export interface WaGroupChange {
    groupId: string | null;
    /**
     * group_create, group_delete, group_participants_add,
     * group_participants_remove, group_join_request_created,
     * group_join_request_revoked, group_settings_update, group_suspend,
     * group_suspend_cleared.
     */
    type: string;
    requestId: string | null;
    timestamp: Date | null;
    subject: string | null;
    description: string | null;
    inviteLink: string | null;
    joinApprovalMode: string | null;
    reason: string | null;
    /** `business` or `participant`, on removals. */
    initiatedBy: string | null;
    /** The wa_id (or the number Meta echoes as `input`) of each participant added, removed, or not removed. */
    added: string[];
    removed: string[];
    failed: string[];
    joinRequestId: string | null;
    /** The user a join request is about. */
    waId: string | null;
    errors: WaError[];
    raw: Record<string, unknown>;
}

export type WaGroupField = 'group_lifecycle_update' | 'group_participants_update' | 'group_settings_update' | 'group_status_update';

/** One entry of a `calls` webhook (Business Calling API). */
export interface WaCall {
    /** wacid… */
    id: string;
    /** connect or terminate. */
    event: string;
    /** USER_INITIATED or BUSINESS_INITIATED. */
    direction: string | null;
    timestamp: Date | null;
    /** The person on the other end, whichever side placed the call. */
    user: WaContactRef | null;
    /** offer (a person's call) or answer (to the business's offer). */
    sdpType: string | null;
    sdp: string | null;
    /** terminate: COMPLETED or FAILED. */
    status: string | null;
    /** terminate, when the call was answered. */
    startTime: Date | null;
    endTime: Date | null;
    duration: number | null;
    bizOpaqueCallbackData: string | null;
    errors: WaError[];
    raw: Record<string, unknown>;
}

/** WhatsApp Pay: a payment on an `order_details` bill, from the gateway Meta is linked to. */
export interface WaPayment {
    referenceId: string;
    /** captured | pending */
    status: string;
    /** In paise (value / offset 100). */
    amount: number | null;
    currency: string | null;
    transactionId: string | null;
    method: string | null;
    raw: Record<string, unknown>;
}

export interface WaSyncedContact {
    action: 'add' | 'remove' | string;
    fullName: string | null;
    firstName: string | null;
    contact: WaContactRef;
    at: Date | null;
}

interface Base {
    /** entry.id — the WhatsApp Business (Messaging) account id. */
    wabaId: string;
    /** value.metadata.phone_number_id, when the field carries one. */
    phoneNumberId: string | null;
    displayPhoneNumber: string | null;
}

export type WaEvent =
    | (Base & { kind: 'message'; message: WaMessage })
    | (Base & { kind: 'echo'; message: WaMessage })
    | (Base & { kind: 'status'; status: WaStatus })
    | (Base & { kind: 'payment'; payment: WaPayment })
    | (Base & { kind: 'payment_configuration'; name: string | null; provider: string | null; status: string | null; value: Record<string, unknown> })
    | (Base & {
        kind: 'history_chunk';
        phase: number | null;
        chunkOrder: number | null;
        progress: number | null;
        threads: Array<{ contact: WaContactRef; messages: WaMessage[] }>;
    })
    | (Base & { kind: 'history_media'; messages: WaMessage[] })
    | (Base & { kind: 'history_declined'; errors: WaError[] })
    | (Base & { kind: 'contact_sync'; contacts: WaSyncedContact[] })
    | (Base & { kind: 'user_preference'; contact: WaContactRef; category: string | null; value: string | null; at: Date | null })
    | (Base & {
        kind: 'account_update';
        event: string | null;
        phoneNumber: string | null;
        reason: string | null;
        initiatedBy: string | null;
        value: Record<string, unknown>;
    })
    | (Base & {
        kind: 'template_update';
        field: string;
        templateId: string | null;
        name: string | null;
        language: string | null;
        event: string | null;
        value: Record<string, unknown>;
    })
    | (Base & { kind: 'number_update'; field: string; event: string | null; value: Record<string, unknown> })
    | (Base & { kind: 'value_errors'; errors: WaError[] })
    | (Base & { kind: 'group'; field: WaGroupField; change: WaGroupChange })
    | (Base & { kind: 'call'; call: WaCall })
    /** A business call's progress: RINGING, ACCEPTED or REJECTED. */
    | (Base & { kind: 'call_status'; callId: string; status: string; at: Date | null; recipient: WaContactRef })
    | (Base & { kind: 'other'; field: string; value: Record<string, unknown> });

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function arr(v: unknown): Obj[] {
    return Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : [];
}

function str(v: unknown): string | null {
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
}

function num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

/** Meta sends unix seconds, as a string in examples and an integer in the tables. */
function seconds(v: unknown): Date | null {
    const n = num(v);
    return n === null ? null : new Date(n * 1000);
}

function errorsOf(v: unknown): WaError[] {
    return arr(v).map((e) => ({
        code: num(e.code),
        title: str(e.title),
        message: str(e.message),
        details: str(obj(e.error_data)?.details),
    }));
}

/** `value.contacts[]`, keyed so a message's sender can find its profile. */
function contactIndex(value: Obj): Map<string, Obj> {
    const index = new Map<string, Obj>();
    for (const c of arr(value.contacts)) {
        const waId = str(c.wa_id);
        const userId = str(c.user_id);
        if (waId) index.set(`wa:${waId}`, c);
        if (userId) index.set(`u:${userId}`, c);
    }
    return index;
}

function contactRef(
    waId: string | null,
    userId: string | null,
    index: Map<string, Obj>,
    extra?: Obj | null,
): WaContactRef {
    const c = (userId && index.get(`u:${userId}`)) || (waId && index.get(`wa:${waId}`)) || extra || null;
    const profile = obj(c?.profile);
    return {
        userId: userId ?? str(c?.user_id),
        waId: waId ?? str(c?.wa_id),
        username: str(profile?.username) ?? str(c?.username),
        profileName: str(profile?.name),
    };
}

/** The readable text of a message, for previews and keyword matching. */
export function waMessageText(m: Obj): string | null {
    const type = str(m.type);
    const body = type ? obj(m[type]) : null;
    switch (type) {
        case 'text':
            return str(body?.body);
        case 'image':
        case 'video':
        case 'document':
            return str(body?.caption);
        case 'interactive': {
            const kind = str(body?.type);
            const reply = kind ? obj(body?.[kind]) : null;
            if (kind === 'nfm_reply') return str(reply?.body);
            if (kind === 'call_permission_reply') return reply?.response === 'accept' ? 'Allowed calls from the business' : 'Declined calls from the business';
            return str(reply?.title);
        }
        case 'button':
            return str(body?.text);
        case 'reaction':
            return str(body?.emoji);
        case 'location':
            return str(body?.name) ?? str(body?.address);
        case 'contacts':
            return (
                arr(m.contacts)
                    .map((c) => str(obj(c.name)?.formatted_name))
                    .filter(Boolean)
                    .join(', ') || null
            );
        case 'order':
            return str(body?.text);
        case 'system':
            return str(body?.body);
        case 'edit': {
            const inner = obj(body?.message);
            return inner ? waMessageText(inner) : null;
        }
        default:
            return null;
    }
}

function toMessage(
    m: Obj,
    index: Map<string, Obj>,
    direction: 'inbound' | 'business',
    businessNumber: string | null,
): WaMessage | null {
    const id = str(m.id);
    const timestamp = seconds(m.timestamp);
    const type = str(m.type);
    if (!id || !timestamp || !type) return null;

    const fromNumber = str(m.from);
    const sentByBusiness =
        direction === 'business' || (businessNumber !== null && fromNumber === businessNumber);
    const context = obj(m.context);

    return {
        id,
        timestamp,
        type,
        from: sentByBusiness ? null : contactRef(fromNumber, str(m.from_user_id), index),
        to: sentByBusiness ? contactRef(str(m.to), str(m.to_user_id), index) : null,
        text: waMessageText(m),
        context: context ? { from: str(context.from), id: str(context.id) } : null,
        referral: obj(m.referral),
        errors: errorsOf(m.errors),
        historyStatus: str(obj(m.history_context)?.status),
        groupId: str(m.group_id),
        raw: m,
    };
}

function toStatus(s: Obj, index: Map<string, Obj>): WaStatus | null {
    const messageId = str(s.id);
    const timestamp = seconds(s.timestamp);
    const status = str(s.status);
    if (!messageId || !timestamp || !status) return null;
    const pricing = obj(s.pricing);
    const group = str(s.recipient_type) === 'group';
    // Meta's examples spell the participant both ways.
    const participant = group ? (str(s.participant_recipient_id) ?? str(s.recipient_participant_id)) : null;
    return {
        messageId,
        status,
        timestamp,
        recipient: group ? contactRef(participant, null, index) : contactRef(str(s.recipient_id), str(s.recipient_user_id), index),
        pricing: pricing
            ? {
                type: str(pricing.type),
                category: str(pricing.category),
                billable: typeof pricing.billable === 'boolean' ? pricing.billable : null,
            }
            : null,
        errors: errorsOf(s.errors),
        bizOpaqueCallbackData: str(s.biz_opaque_callback_data),
        groupId: group ? str(s.recipient_id) : null,
        participant,
        raw: s,
    };
}

const participantIds = (v: unknown) => arr(v).map((p) => str(p.wa_id) ?? str(p.input)).filter((id): id is string => !!id);

/** A setting changed by a `group_settings_update`, or null when it was not, or failed. */
function changedSetting(v: unknown): string | null {
    const setting = obj(v);
    return setting && setting.update_successful !== false ? str(setting.text) : null;
}

function toCall(c: Obj, index: Map<string, Obj>): WaCall | null {
    const id = str(c.id);
    const event = str(c.event);
    if (!id || !event) return null;
    const direction = str(c.direction);
    const session = obj(c.session);
    // Meta's older samples carry the SDP in connection.webrtc.sdp.
    const legacy = obj(obj(c.connection)?.webrtc);
    return {
        id,
        event,
        direction,
        timestamp: seconds(c.timestamp),
        user: direction === 'BUSINESS_INITIATED'
            ? contactRef(str(c.to), str(c.to_user_id), index)
            : contactRef(str(c.from), str(c.from_user_id), index),
        sdpType: str(session?.sdp_type),
        sdp: str(session?.sdp) ?? str(legacy?.sdp),
        status: str(c.status),
        startTime: seconds(c.start_time),
        endTime: seconds(c.end_time),
        duration: num(c.duration),
        bizOpaqueCallbackData: str(c.biz_opaque_callback_data),
        errors: errorsOf(c.errors),
        raw: c,
    };
}

function toGroupChange(g: Obj): WaGroupChange | null {
    const type = str(g.type);
    if (!type) return null;
    return {
        groupId: str(g.group_id),
        type,
        requestId: str(g.request_id),
        timestamp: seconds(g.timestamp),
        subject: type === 'group_settings_update' ? changedSetting(g.group_subject) : str(g.subject),
        description: type === 'group_settings_update' ? changedSetting(g.group_description) : str(g.description),
        inviteLink: str(g.invite_link),
        joinApprovalMode: str(g.join_approval_mode),
        reason: str(g.reason),
        initiatedBy: str(g.initiated_by),
        added: participantIds(g.added_participants),
        removed: participantIds(g.removed_participants),
        failed: participantIds(g.failed_participants),
        joinRequestId: str(g.join_request_id),
        waId: str(g.wa_id),
        errors: errorsOf(g.errors),
        raw: g,
    };
}

function toPayment(s: Obj): WaPayment | null {
    const p = obj(s.payment) ?? {};
    const referenceId = str(p.reference_id) ?? str(s.reference_id);
    const status = str(s.status);
    if (!referenceId || !status) return null;
    const amount = obj(p.amount);
    const value = num(amount?.value);
    const offset = num(amount?.offset) ?? 100;
    const transaction = obj(p.transaction);
    return {
        referenceId,
        status,
        amount: value === null ? null : Math.round((value * 100) / offset),
        currency: str(p.currency),
        transactionId: str(transaction?.id),
        method: str(obj(transaction?.method)?.type),
        raw: s,
    };
}

/** Every event in one `whatsapp_business_account` delivery, in payload order. */
export function parseWhatsAppDelivery(body: unknown): WaEvent[] {
    const events: WaEvent[] = [];
    const root = obj(body);
    if (!root || root.object !== 'whatsapp_business_account') return events;

    for (const entry of arr(root.entry)) {
        const wabaId = str(entry.id);
        if (!wabaId) continue;
        for (const change of arr(entry.changes)) {
            const field = str(change.field);
            const value = obj(change.value);
            if (!field || !value) continue;
            const metadata = obj(value.metadata);
            const base: Base = {
                wabaId,
                phoneNumberId: str(metadata?.phone_number_id),
                displayPhoneNumber: str(metadata?.display_phone_number),
            };
            events.push(...parseChange(field, value, base));
        }
    }
    return events;
}

function parseChange(field: string, value: Obj, base: Base): WaEvent[] {
    const index = contactIndex(value);
    const out: WaEvent[] = [];

    switch (field) {
        case 'messages': {
            for (const m of arr(value.messages)) {
                const message = toMessage(m, index, 'inbound', base.displayPhoneNumber);
                if (message) out.push({ ...base, kind: 'message', message });
            }
            for (const s of arr(value.statuses)) {
                if (str(s.type) === 'payment') {
                    const payment = toPayment(s);
                    if (payment) out.push({ ...base, kind: 'payment', payment });
                    continue;
                }
                const status = toStatus(s, index);
                if (status) out.push({ ...base, kind: 'status', status });
            }
            const errors = errorsOf(value.errors);
            if (errors.length) out.push({ ...base, kind: 'value_errors', errors });
            return out;
        }

        case 'smb_message_echoes': {
            for (const m of arr(value.message_echoes)) {
                const message = toMessage(m, index, 'business', base.displayPhoneNumber);
                if (message) out.push({ ...base, kind: 'echo', message });
            }
            return out;
        }

        case 'history': {
            // Two shapes share this field: the chunked `history[]` sync, and a
            // later delivery of media ids for recent media, which carries plain
            // `messages[]` / `message_echoes[]` keyed by the placeholder's wamid.
            for (const h of arr(value.history)) {
                const errors = errorsOf(h.errors);
                if (errors.length) {
                    out.push({ ...base, kind: 'history_declined', errors });
                    continue;
                }
                const meta = obj(h.metadata);
                out.push({
                    ...base,
                    kind: 'history_chunk',
                    phase: num(meta?.phase),
                    chunkOrder: num(meta?.chunk_order),
                    progress: num(meta?.progress),
                    threads: arr(h.threads).map((t) => {
                        const ctx = obj(t.context);
                        const contact = contactRef(
                            str(ctx?.wa_id) ?? str(t.id),
                            str(ctx?.user_id),
                            index,
                            ctx,
                        );
                        if (!contact.username) contact.username = str(ctx?.username);
                        const messages = arr(t.messages)
                            .map((m) => toMessage(m, index, 'inbound', base.displayPhoneNumber))
                            .filter((m): m is WaMessage => !!m);
                        for (const m of messages) {
                            // A business-sent item may omit `to`; the thread
                            // itself names the customer.
                            if (m.from === null && !m.to?.userId && !m.to?.waId) m.to = contact;
                        }
                        return { contact, messages };
                    }),
                });
            }
            const media = [
                ...arr(value.messages).map((m) => toMessage(m, index, 'inbound', base.displayPhoneNumber)),
                ...arr(value.message_echoes).map((m) => toMessage(m, index, 'business', base.displayPhoneNumber)),
            ].filter((m): m is WaMessage => !!m);
            if (media.length) out.push({ ...base, kind: 'history_media', messages: media });
            return out;
        }

        case 'smb_app_state_sync': {
            const contacts = arr(value.state_sync)
                .filter((s) => str(s.type) === 'contact')
                .map((s): WaSyncedContact => {
                    const c = obj(s.contact) ?? {};
                    return {
                        action: str(s.action) ?? 'add',
                        fullName: str(c.full_name),
                        firstName: str(c.first_name),
                        contact: {
                            userId: str(c.user_id),
                            waId: str(c.phone_number),
                            username: str(c.username),
                            profileName: str(c.full_name),
                        },
                        at: seconds(obj(s.metadata)?.timestamp),
                    };
                });
            if (contacts.length) out.push({ ...base, kind: 'contact_sync', contacts });
            return out;
        }

        case 'user_preferences': {
            for (const p of arr(value.user_preferences)) {
                out.push({
                    ...base,
                    kind: 'user_preference',
                    contact: contactRef(str(p.wa_id), str(p.user_id), index),
                    category: str(p.category),
                    value: str(p.value),
                    at: seconds(p.timestamp),
                });
            }
            return out;
        }

        case 'account_update': {
            const info = obj(value.disconnection_info);
            out.push({
                ...base,
                kind: 'account_update',
                event: str(value.event),
                phoneNumber: str(value.phone_number),
                reason: str(info?.reason),
                initiatedBy: str(info?.initiated_by),
                value,
            });
            return out;
        }

        case 'message_template_status_update':
        case 'message_template_quality_update':
        case 'template_category_update':
        case 'message_template_components_update':
            out.push({
                ...base,
                kind: 'template_update',
                field,
                templateId: str(value.message_template_id),
                name: str(value.message_template_name),
                language: str(value.message_template_language),
                event: str(value.event) ?? str(value.new_quality_score) ?? str(value.new_category),
                value,
            });
            return out;

        case 'calls':
            for (const c of arr(value.calls)) {
                const call = toCall(c, index);
                if (call) out.push({ ...base, kind: 'call', call });
            }
            // A business call's progress comes on this field too, as statuses of type call.
            for (const s of arr(value.statuses)) {
                const callId = str(s.id);
                const status = str(s.status);
                if (callId && status) {
                    out.push({ ...base, kind: 'call_status', callId, status, at: seconds(s.timestamp), recipient: contactRef(str(s.recipient_id), str(s.recipient_user_id), index) });
                }
            }
            return out;

        case 'group_lifecycle_update':
        case 'group_participants_update':
        case 'group_settings_update':
        case 'group_status_update':
            for (const g of arr(value.groups)) {
                const change = toGroupChange(g);
                if (change) out.push({ ...base, kind: 'group', field, change });
            }
            return out;

        case 'payment_configuration_update':
            out.push({ ...base, kind: 'payment_configuration', name: str(value.configuration_name), provider: str(value.provider_name), status: str(value.status), value });
            return out;

        case 'phone_number_quality_update':
        case 'phone_number_name_update':
        case 'business_capability_update':
        case 'account_alerts':
        case 'account_review_update':
            out.push({ ...base, kind: 'number_update', field, event: str(value.event) ?? str(value.decision), value });
            return out;

        default:
            out.push({ ...base, kind: 'other', field, value });
            return out;
    }
}
