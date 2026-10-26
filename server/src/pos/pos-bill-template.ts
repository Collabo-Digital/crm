import { ParamValue, ParameterFormat, TemplateParam, templateParams } from '../campaigns/templates/template-components';

/**
 * The WhatsApp template a bill goes out in. The till knows it by its link
 * button opening `<app>/b/{{1}}`, not by its name, so a renamed copy still
 * counts; and it fills only what a bill knows — the starter's five values,
 * by name or in the starter's order — so a template asking for anything else
 * is not the bill template. Pure.
 */

export interface BillValues {
    firstName: string;
    storeName: string;
    billNumber: string;
    billTotal: string;
    billDate: string;
}

const BY_NAME: Record<string, keyof BillValues> = {
    first_name: 'firstName',
    store_name: 'storeName',
    bill_number: 'billNumber',
    bill_total: 'billTotal',
    bill_date: 'billDate',
};
/** {{1}} to {{5}} of a numbered copy, in the starter's order. */
const BY_POSITION: Array<keyof BillValues> = ['firstName', 'storeName', 'billNumber', 'billTotal', 'billDate'];

type TemplateLike = { category: string; parameterFormat: string; components: unknown };

const formatOf = (t: TemplateLike): ParameterFormat => (t.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL');
const componentsOf = (t: TemplateLike) => (Array.isArray(t.components) ? (t.components as Record<string, any>[]) : []);

/** Index of the button that opens the bill, or -1. */
function billButton(t: TemplateLike, linkPrefix: string): number {
    const buttons: Record<string, any>[] = componentsOf(t).find((c) => String(c.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
    return buttons.findIndex((b) => String(b.type).toUpperCase() === 'URL' && String(b.url ?? '').trim() === `${linkPrefix}{{1}}`);
}

function valueKey(p: TemplateParam, format: ParameterFormat): keyof BillValues | undefined {
    if (p.component !== 'body') return undefined;
    return format === 'NAMED' ? BY_NAME[p.name] : BY_POSITION[Number(p.name) - 1];
}

/** A utility template with the bill's link button and nothing to fill that a bill doesn't know. */
export function isBillTemplate(t: TemplateLike, linkPrefix: string): boolean {
    if (t.category !== 'UTILITY') return false;
    const button = billButton(t, linkPrefix);
    if (button < 0) return false;
    const format = formatOf(t);
    return templateParams(componentsOf(t), format).every((p) => (p.component === 'button' ? p.kind === 'text' && p.buttonIndex === button : !!valueKey(p, format)));
}

/** The values to send a bill template with: the bill's details, and its link's token on the button. */
export function billTemplateValues(t: TemplateLike, values: BillValues, token: string): Record<string, ParamValue> {
    const format = formatOf(t);
    const out: Record<string, ParamValue> = {};
    for (const p of templateParams(componentsOf(t), format)) {
        const key = valueKey(p, format);
        out[p.key] = p.component === 'button' ? token : key ? values[key] : '';
    }
    return out;
}
