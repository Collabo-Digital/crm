import { ChannelPlatform } from '@prisma/client';

export interface AdReferralFields {
    adId: string;
    headline: string | null;
    body: string | null;
    sourceUrl: string | null;
    mediaUrl: string | null;
    ctwaClid: string | null;
    ref: string | null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Obj) : null);

/**
 * The ad a chat came from, from the referral on its first message. WhatsApp:
 * `source_type: "ad"`, `source_id`, `headline`, `body`, the media URLs and
 * `ctwa_clid` (absent for Status ads). Messenger and Instagram:
 * `source: "ADS"`, `ad_id`, `ref` and `ads_context_data`. Null for other
 * referrals (an m.me or ig.me link, a post).
 */
export function adReferral(platform: ChannelPlatform, raw: unknown): AdReferralFields | null {
    const r = obj(raw);
    if (!r) return null;
    if (platform === ChannelPlatform.WHATSAPP) {
        const adId = str(r.source_id);
        if (str(r.source_type) !== 'ad' || !adId) return null;
        return {
            adId,
            headline: str(r.headline),
            body: str(r.body),
            sourceUrl: str(r.source_url),
            mediaUrl: str(r.image_url) ?? str(r.thumbnail_url) ?? str(r.video_url),
            ctwaClid: str(r.ctwa_clid),
            ref: null,
        };
    }
    const adId = str(r.ad_id);
    if (!adId || (r.source !== undefined && str(r.source)?.toUpperCase() !== 'ADS')) return null;
    const ctx = obj(r.ads_context_data);
    return {
        adId,
        headline: str(ctx?.ad_title),
        body: null,
        sourceUrl: null,
        mediaUrl: str(ctx?.photo_url) ?? str(ctx?.video_url),
        ctwaClid: null,
        ref: str(r.ref),
    };
}

/** Meta's "Messaging Conversations Started" action type on ad insights. */
export const CONVERSATIONS_STARTED = 'onsite_conversion.messaging_conversation_started_7d';

export function actionValue(actions: unknown, type: string): number {
    const list = Array.isArray(actions) ? (actions as Array<{ action_type?: string; value?: string }>) : [];
    const hit = list.find((a) => a.action_type === type);
    const n = Number(hit?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/** YYYY-MM-DD in the organization's time zone, for Insights' time_range. */
export function dayIn(timeZone: string, at: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
