import { AutomationStatus } from '@prisma/client';
import { PACK_LANGUAGE, type PackSlot } from '../../campaigns/templates/pack/template-pack';
import { latestPackTemplate, pickPackTemplate, type PackTemplateRow } from '../../campaigns/templates/pack/pick-pack-template';

/**
 * Where a recommended-pack automation stands, for the automations list.
 * live: it is on · waiting: it goes live by itself once Meta approves its
 * templates · ready: off, every template approved · off: off, templates not
 * all approved · attention: one of its templates was rejected, disabled or
 * moved to marketing · duplicate: held back, an automation of the
 * merchant's starts on the same event.
 */
export type PackState = 'live' | 'waiting' | 'ready' | 'off' | 'attention' | 'duplicate';

export interface SlotStanding {
    title: string;
    /** It has an approved template to send with (in either category). */
    approved: boolean;
    /** Its newest template is paused by Meta and none is approved: its sends wait. */
    paused: boolean;
    problem: 'rejected' | 'disabled' | 'marketing' | null;
}

/** How one slot stands on the account, from its pack templates (every version). */
export function slotStanding(rows: PackTemplateRow[], slot: PackSlot): SlotStanding {
    const picked = pickPackTemplate(rows, slot.key, slot.category, PACK_LANGUAGE);
    if (picked) return { title: slot.title, approved: true, paused: false, problem: picked.category === slot.category ? null : 'marketing' };
    const status = latestPackTemplate(rows, slot.key, PACK_LANGUAGE)?.status;
    return {
        title: slot.title,
        approved: false,
        paused: status === 'PAUSED',
        problem: status === 'REJECTED' ? 'rejected' : status === 'DISABLED' ? 'disabled' : null,
    };
}

const PROBLEM: Record<NonNullable<SlotStanding['problem']>, (title: string) => string> = {
    rejected: (t) => `Meta rejected its “${t}” template.`,
    disabled: (t) => `Meta disabled its “${t}” template.`,
    marketing: (t) => `Meta approved its “${t}” template as marketing, which costs more and does not reach people who stopped promotions.`,
};

export function packStateOf(input: {
    status: AutomationStatus;
    activateWhenReady: boolean;
    slots: SlotStanding[];
    /** The merchant's live automation that starts on the same event, if any. */
    duplicateOf: string | null;
}): { state: PackState; note: string | null } {
    const problem = input.slots.find((s) => s.problem);
    const attention = problem ? { state: 'attention' as const, note: PROBLEM[problem.problem!](problem.title) } : null;
    if (input.status === AutomationStatus.ACTIVE) {
        if (attention) return attention;
        const paused = input.slots.find((s) => s.paused);
        return { state: 'live', note: paused ? `Meta paused its “${paused.title}” template. Its messages wait until the pause ends.` : null };
    }
    if (input.status === AutomationStatus.ARCHIVED) return { state: 'off', note: null };
    if (input.duplicateOf) return { state: 'duplicate', note: `Not turned on because your automation “${input.duplicateOf}” already starts on the same event.` };
    if (attention) return attention;
    if (input.activateWhenReady) return { state: 'waiting', note: 'Goes live by itself when Meta approves its templates.' };
    if (input.slots.every((s) => s.approved)) return { state: 'ready', note: 'Ready to turn on.' };
    return { state: 'off', note: 'Off. If you turn it on, it goes live once Meta approves its templates.' };
}
