import type { TemplateCategoryName } from '../template-components';

/** The fields of a MessageTemplate row the choice reads. */
export interface PackTemplateRow {
    id: string;
    packSlot: string | null;
    packVersion: number | null;
    status: string;
    category: string;
    language: string;
    updatedAt: Date;
}

const rank = (t: PackTemplateRow, category: TemplateCategoryName) =>
    // Approved in the slot's own category first: a utility slot Meta moved to
    // marketing still sends, but at the marketing price and not to people who
    // stopped promotions, so an approved utility sibling beats it.
    t.status === 'APPROVED' ? (t.category === category ? 0 : 1) : 2;

/**
 * The template one slot of the pack should send with, from one account's
 * pack templates (every version and variant of every slot): approved first,
 * in the slot's category first, then the newest version. Null when the slot
 * has no approved template; `latestPackTemplate` says why.
 */
export function pickPackTemplate<T extends PackTemplateRow>(rows: T[], slot: string, category: TemplateCategoryName, language = 'en'): T | null {
    const best = rows
        .filter((t) => t.packSlot === slot && t.language === language && t.status === 'APPROVED')
        .sort((a, b) => rank(a, category) - rank(b, category) || (b.packVersion ?? 0) - (a.packVersion ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime());
    return best[0] ?? null;
}

/** The slot's newest template whatever its status: what to show while none is approved. */
export function latestPackTemplate<T extends PackTemplateRow>(rows: T[], slot: string, language = 'en'): T | null {
    const all = rows
        .filter((t) => t.packSlot === slot && t.language === language)
        .sort((a, b) => (b.packVersion ?? 0) - (a.packVersion ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime());
    return all[0] ?? null;
}
