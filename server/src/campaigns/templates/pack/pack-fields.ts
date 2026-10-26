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

/**
 * The pack fields of a template known only by its name: `collabo_<slot>_v<n>`
 * in English is a pack template, made by an earlier run, before a reconnect,
 * or by a request Meta took although it never answered.
 */
export function packFieldsFromName(t: { name: string; language: string; library_template_name?: string | null }): PackFields | null {
    const m = t.language === PACK_LANGUAGE ? PACK_NAME.exec(t.name) : null;
    if (!m || !SLOTS.has(m[1])) return null;
    return {
        packSlot: m[1],
        packVersion: Number(m[2]),
        packSource: t.library_template_name ? 'library' : 'collabo',
        libraryTemplateName: t.library_template_name || null,
    };
}
