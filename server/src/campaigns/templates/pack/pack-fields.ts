import { storeLinkPrefix } from '../../../commerce/store-links';
import { billLinkPrefix } from '../template-starters';
import { PACK_LANGUAGE, templatePack } from './template-pack';

/** What a pack template's row carries, besides the template itself. */
export interface PackFields {
    packSlot: string;
    packVersion: number;
    packSource: 'library' | 'collabo';
    libraryTemplateName: string | null;
}

const SLOTS = new Set<string>(templatePack('').map((s) => s.key));
const PACK_NAME = /^collabo_([a-z0-9_]+)_v(\d+)$/;
const RAZORPAY_LINK = 'https://rzp.io/{{1}}';

/**
 * Whether every link button of a template opens this app's order, cart or
 * bill pages (or Razorpay). A preview and production can share one WhatsApp
 * account: a pack template the other one made opens the other app, so it is
 * not this one's to send.
 */
export function opensThisApp(components: unknown, frontendUrl: string): boolean {
    const own = [storeLinkPrefix(frontendUrl, 'order'), storeLinkPrefix(frontendUrl, 'cart'), billLinkPrefix(frontendUrl)];
    const buttons = (Array.isArray(components) ? components : [])
        .filter((c) => String((c as { type?: unknown })?.type).toUpperCase() === 'BUTTONS')
        .flatMap((c) => ((c as { buttons?: unknown[] }).buttons ?? []) as Array<{ type?: unknown; url?: unknown }>);
    return buttons
        .filter((b) => String(b?.type).toUpperCase() === 'URL')
        .every((b) => {
            const url = String(b.url ?? '').trim();
            return url === RAZORPAY_LINK || own.some((prefix) => url.startsWith(prefix));
        });
}

/**
 * The pack fields of a template known only by its name: `collabo_<slot>_v<n>`
 * in English whose links open this app is a pack template, made by an earlier
 * run, before a reconnect, or by a request Meta took although it never
 * answered.
 */
export function packFieldsFromName(
    t: { name: string; language: string; library_template_name?: string | null; components?: unknown },
    frontendUrl: string,
): PackFields | null {
    const m = t.language === PACK_LANGUAGE ? PACK_NAME.exec(t.name) : null;
    if (!m || !SLOTS.has(m[1]) || !opensThisApp(t.components, frontendUrl)) return null;
    return {
        packSlot: m[1],
        packVersion: Number(m[2]),
        packSource: t.library_template_name ? 'library' : 'collabo',
        libraryTemplateName: t.library_template_name || null,
    };
}
