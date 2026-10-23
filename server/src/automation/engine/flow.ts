/**
 * Walking an automation's step tree. Pure.
 *
 * A definition is a list of steps; a branching step (condition, wait for
 * reply) carries named lists of its own. When a branch runs out, the flow
 * carries on with the step after the branching one — like the end of an if
 * block — so a branch only has to hold what differs.
 */

export interface FlowStep {
    id: string;
    type: string;
    config: Record<string, unknown>;
    branches?: Record<string, FlowStep[]>;
}

interface Position {
    step: FlowStep;
    list: FlowStep[];
    index: number;
    /** The branching step this list belongs to, if any. */
    parent: FlowStep | null;
}

export class Flow {
    private readonly positions = new Map<string, Position>();

    constructor(readonly steps: FlowStep[]) {
        const walk = (list: FlowStep[], parent: FlowStep | null) =>
            list.forEach((step, index) => {
                this.positions.set(step.id, { step, list, index, parent });
                for (const branch of Object.values(step.branches ?? {})) walk(branch, step);
            });
        walk(steps, null);
    }

    get trigger(): FlowStep {
        return this.steps[0];
    }

    step(id: string): FlowStep | null {
        return this.positions.get(id)?.step ?? null;
    }

    /** The first action, after the trigger. */
    first(): FlowStep | null {
        return this.steps[1] ?? null;
    }

    /** What runs after `id` finishes: its next sibling, or the step after the branch it sits in. */
    next(id: string): FlowStep | null {
        const pos = this.positions.get(id);
        if (!pos) return null;
        if (pos.index + 1 < pos.list.length) return pos.list[pos.index + 1];
        return pos.parent ? this.next(pos.parent.id) : null;
    }

    /** Enter a branch of a branching step; an empty branch goes straight on. */
    enter(id: string, branch: string): FlowStep | null {
        const step = this.step(id);
        const list = step?.branches?.[branch];
        if (list?.length) return list[0];
        return this.next(id);
    }

    /** Every step, depth first, with the branch path to it ("yes", "replied/no"…). */
    all(): Array<{ step: FlowStep; path: string[] }> {
        const out: Array<{ step: FlowStep; path: string[] }> = [];
        const walk = (list: FlowStep[], path: string[]) => {
            for (const step of list) {
                out.push({ step, path });
                for (const [name, branch] of Object.entries(step.branches ?? {})) walk(branch, [...path, `${step.type}:${name}`]);
            }
        };
        walk(this.steps, []);
        return out;
    }
}

/** Run context values, by name. */
export type FlowVariables = Record<string, string | number | boolean | null | undefined>;

const VARIABLE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Variable names a text uses. */
export function variablesUsed(text: string): string[] {
    return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]))];
}

/**
 * Fill {{name}} placeholders from the run's variables. A missing value
 * becomes empty text rather than a visible {{placeholder}} in a customer's
 * message; `{{first_name|there}}`-style defaults are written as fallbacks in
 * the step instead.
 */
export function interpolate(text: string, vars: FlowVariables): string {
    return text
        .replace(VARIABLE, (_m, name: string) => {
            const value = vars[name];
            return value === null || value === undefined ? '' : String(value);
        })
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ([,.!?])/g, '$1');
}

/** Minutes in an amount of a unit. */
export function toMinutes(amount: number, unit: 'minutes' | 'hours' | 'days'): number {
    return amount * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1);
}

/** Does `text` match a keyword list the way a trigger asks? Case- and accent-insensitive. */
export function keywordMatches(text: string | null | undefined, keywords: string[], match: 'contains' | 'exact' | 'any'): boolean {
    if (match === 'any' || keywords.length === 0) return true;
    const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const t = norm(text ?? '');
    if (!t) return false;
    return keywords.some((k) => {
        const kw = norm(k);
        if (!kw) return false;
        if (match === 'exact') return t === kw;
        // Whole words: "hi" must not fire on "this".
        return new RegExp(`(^|[^\\p{L}\\p{N}])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(t);
    });
}
