/**
 * WhatsApp template components: building them from the editor, reading the
 * parameters a template needs, and filling them in for a send. Pure.
 *
 * Shapes and limits from Meta's template docs (templates/components,
 * templates/overview, marketing-templates/coupon-templates,
 * marketing-templates/custom-marketing-templates). Creation uses upper-case
 * component types; sending uses lower-case ones.
 */

export type TemplateCategoryName = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
export type ParameterFormat = 'POSITIONAL' | 'NAMED';
export type HeaderMediaFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export type DraftButton =
    | { type: 'QUICK_REPLY'; text: string }
    | { type: 'URL'; text: string; url: string; example?: string }
    | { type: 'PHONE_NUMBER'; text: string; phoneNumber: string }
    | { type: 'COPY_CODE'; example: string };

/** What the template editor sends. */
export interface TemplateDraft {
    name: string;
    language: string;
    category: TemplateCategoryName;
    parameterFormat: ParameterFormat;
    header?:
    | { format: 'TEXT'; text: string; example?: string }
    | { format: HeaderMediaFormat; storageKey?: string; mime?: string; filename?: string }
    | { format: 'LOCATION' };
    body: { text: string; examples: Record<string, string> };
    footer?: string;
    buttons?: DraftButton[];
}

/** One value a send has to supply. */
export interface TemplateParam {
    /** Stable key for the value map: header, body.1, body.first_name, button.0, coupon.1. */
    key: string;
    component: 'header' | 'body' | 'button';
    kind: 'text' | 'image' | 'video' | 'document' | 'location' | 'coupon_code';
    /** "1" or "first_name"; the button index for buttons. */
    name: string;
    buttonIndex?: number;
    example?: string;
}

/** A value for one parameter at send time. */
export type ParamValue =
    | string
    | { mediaId: string }
    | { link: string }
    | { latitude: number; longitude: number; name?: string; address?: string };

type MetaComponent = Record<string, any>;

const NAME = /^[a-z0-9_]+$/;
const NAMED_VAR = /^[a-z_]+$/;
const VAR = /\{\{\s*([^}\s]+)\s*\}\}/g;

export class TemplateDraftError extends Error { }

/** Variables used in a text, in order of first appearance. */
export function variablesIn(text: string): string[] {
    const seen: string[] = [];
    for (const match of text.matchAll(VAR)) if (!seen.includes(match[1])) seen.push(match[1]);
    return seen;
}

function checkVariables(text: string, format: ParameterFormat, where: string): string[] {
    const vars = variablesIn(text);
    if (format === 'POSITIONAL') {
        vars.forEach((v, i) => {
            if (v !== String(i + 1)) throw new TemplateDraftError(`${where}: number variables in order — {{1}}, {{2}}, …`);
        });
    } else {
        for (const v of vars) {
            if (!NAMED_VAR.test(v)) throw new TemplateDraftError(`${where}: variable names use lower-case letters and underscores, like {{first_name}}.`);
        }
    }
    return vars;
}

/**
 * The `components` for POST /<WABA_ID>/message_templates. A media header
 * needs the handle from the Resumable Upload API, passed in once uploaded.
 */
export function toMetaComponents(draft: TemplateDraft, headerHandle?: string | null): MetaComponent[] {
    if (!NAME.test(draft.name) || draft.name.length > 512) {
        throw new TemplateDraftError('Template names use lower-case letters, digits and underscores only.');
    }
    if (draft.category === 'AUTHENTICATION') {
        throw new TemplateDraftError('Authentication templates must be created from Meta’s own library in WhatsApp Manager.');
    }
    const components: MetaComponent[] = [];
    const header = draft.header;
    if (header) {
        if (header.format === 'TEXT') {
            if (!header.text.trim()) throw new TemplateDraftError('Header: write the header text or remove it.');
            if (header.text.length > 60) throw new TemplateDraftError('Header text can be at most 60 characters.');
            const vars = variablesIn(header.text);
            if (vars.length > 1) throw new TemplateDraftError('The header can have at most one variable.');
            if (vars.length && draft.parameterFormat === 'NAMED') {
                throw new TemplateDraftError('Header variables are only supported with numbered variables here.');
            }
            checkVariables(header.text, 'POSITIONAL', 'Header');
            if (vars.length && !header.example?.trim()) throw new TemplateDraftError('Header: give an example value for {{1}}.');
            components.push({
                type: 'HEADER',
                format: 'TEXT',
                text: header.text,
                ...(vars.length ? { example: { header_text: [header.example!.trim()] } } : {}),
            });
        } else if (header.format === 'LOCATION') {
            if (draft.category !== 'MARKETING' && draft.category !== 'UTILITY') {
                throw new TemplateDraftError('Location headers are for marketing and utility templates.');
            }
            components.push({ type: 'HEADER', format: 'LOCATION' });
        } else {
            if (!headerHandle) throw new TemplateDraftError('Header: upload the image, video or document first.');
            components.push({ type: 'HEADER', format: header.format, example: { header_handle: [headerHandle] } });
        }
    }

    const body = draft.body.text;
    if (!body.trim()) throw new TemplateDraftError('Write the message body.');
    if (body.length > 1024) throw new TemplateDraftError('The body can be at most 1,024 characters.');
    const bodyVars = checkVariables(body, draft.parameterFormat, 'Body');
    for (const v of bodyVars) {
        if (!draft.body.examples[v]?.trim()) throw new TemplateDraftError(`Body: give an example value for {{${v}}}.`);
    }
    components.push({
        type: 'BODY',
        text: body,
        ...(bodyVars.length
            ? draft.parameterFormat === 'NAMED'
                ? { example: { body_text_named_params: bodyVars.map((v) => ({ param_name: v, example: draft.body.examples[v].trim() })) } }
                : { example: { body_text: [bodyVars.map((v) => draft.body.examples[v].trim())] } }
            : {}),
    });

    if (draft.footer?.trim()) {
        if (draft.footer.length > 60) throw new TemplateDraftError('The footer can be at most 60 characters.');
        if (variablesIn(draft.footer).length) throw new TemplateDraftError('The footer cannot have variables.');
        components.push({ type: 'FOOTER', text: draft.footer.trim() });
    }

    const buttons = draft.buttons ?? [];
    if (buttons.length) {
        const count = (t: DraftButton['type']) => buttons.filter((b) => b.type === t).length;
        if (buttons.length > 10) throw new TemplateDraftError('Use at most 10 buttons.');
        if (count('URL') > 2) throw new TemplateDraftError('Use at most 2 link buttons.');
        if (count('PHONE_NUMBER') > 1) throw new TemplateDraftError('Use at most 1 call button.');
        if (count('COPY_CODE') > 1) throw new TemplateDraftError('Use at most 1 copy-code button.');
        components.push({
            type: 'BUTTONS',
            buttons: buttons.map((b) => {
                if (b.type !== 'COPY_CODE' && (!b.text.trim() || b.text.length > 25)) {
                    throw new TemplateDraftError('Button labels are 1 to 25 characters.');
                }
                switch (b.type) {
                    case 'QUICK_REPLY':
                        return { type: 'QUICK_REPLY', text: b.text.trim() };
                    case 'URL': {
                        if (!/^https?:\/\//i.test(b.url) || b.url.length > 2000) throw new TemplateDraftError('Link buttons need a full https:// address.');
                        const vars = variablesIn(b.url);
                        if (vars.length > 1 || (vars.length && !b.url.trimEnd().endsWith('{{1}}'))) {
                            throw new TemplateDraftError('A link can have one variable, {{1}}, at the very end.');
                        }
                        if (vars.length && !b.example?.trim()) throw new TemplateDraftError('Link button: give an example for {{1}}.');
                        return { type: 'URL', text: b.text.trim(), url: b.url.trim(), ...(vars.length ? { example: [b.example!.trim()] } : {}) };
                    }
                    case 'PHONE_NUMBER':
                        if (!/^\+?\d{6,19}$/.test(b.phoneNumber.replace(/[\s-]/g, ''))) throw new TemplateDraftError('Call buttons need a phone number with country code.');
                        return { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: b.phoneNumber.replace(/[\s+-]/g, '') };
                    case 'COPY_CODE':
                        if (!b.example.trim() || b.example.length > 20) throw new TemplateDraftError('Coupon codes are 1 to 20 characters.');
                        return { type: 'COPY_CODE', example: b.example.trim() };
                }
            }),
        });
    }
    return components;
}

/** Back from Meta's components to the editor's shape, to edit a synced template. */
export function fromMetaComponents(
    template: { name: string; language: string; category: TemplateCategoryName; parameterFormat: ParameterFormat },
    components: MetaComponent[],
): TemplateDraft {
    const find = (type: string) => components.find((c) => String(c.type).toUpperCase() === type);
    const header = find('HEADER');
    const body = find('BODY');
    const footer = find('FOOTER');
    const buttons = find('BUTTONS');
    const bodyText: string = body?.text ?? '';
    const examples: Record<string, string> = {};
    if (template.parameterFormat === 'NAMED') {
        for (const p of body?.example?.body_text_named_params ?? []) examples[p.param_name] = p.example;
    } else {
        (body?.example?.body_text?.[0] ?? []).forEach((value: string, i: number) => (examples[String(i + 1)] = value));
    }
    const format = header ? String(header.format).toUpperCase() : null;
    return {
        name: template.name,
        language: template.language,
        category: template.category,
        parameterFormat: template.parameterFormat,
        header: !format
            ? undefined
            : format === 'TEXT'
                ? { format: 'TEXT', text: header!.text ?? '', example: header!.example?.header_text?.[0] }
                : format === 'LOCATION'
                    ? { format: 'LOCATION' }
                    : { format: format as HeaderMediaFormat },
        body: { text: bodyText, examples },
        footer: footer?.text,
        buttons: (buttons?.buttons ?? []).map((b: MetaComponent): DraftButton => {
            switch (String(b.type).toUpperCase()) {
                case 'URL':
                    return { type: 'URL', text: b.text, url: b.url, example: b.example?.[0] };
                case 'PHONE_NUMBER':
                    return { type: 'PHONE_NUMBER', text: b.text, phoneNumber: b.phone_number };
                case 'COPY_CODE':
                    return { type: 'COPY_CODE', example: b.example };
                default:
                    return { type: 'QUICK_REPLY', text: b.text };
            }
        }),
    };
}

/** Every value a send of this template must supply, in display order. */
export function templateParams(components: MetaComponent[], format: ParameterFormat): TemplateParam[] {
    const params: TemplateParam[] = [];
    for (const c of components) {
        const type = String(c.type).toUpperCase();
        if (type === 'HEADER') {
            const f = String(c.format).toUpperCase();
            if (f === 'TEXT') {
                const [v] = variablesIn(c.text ?? '');
                if (v) params.push({ key: 'header', component: 'header', kind: 'text', name: v, example: c.example?.header_text?.[0] });
            } else if (f === 'IMAGE' || f === 'VIDEO' || f === 'DOCUMENT') {
                params.push({ key: 'header', component: 'header', kind: f.toLowerCase() as 'image', name: 'media' });
            } else if (f === 'LOCATION') {
                params.push({ key: 'header', component: 'header', kind: 'location', name: 'location' });
            }
        } else if (type === 'BODY') {
            const named = new Map<string, string>(
                (c.example?.body_text_named_params ?? []).map((p: { param_name: string; example: string }) => [p.param_name, p.example]),
            );
            const positional: string[] = c.example?.body_text?.[0] ?? [];
            for (const v of variablesIn(c.text ?? '')) {
                params.push({
                    key: `body.${v}`,
                    component: 'body',
                    kind: 'text',
                    name: v,
                    example: format === 'NAMED' ? named.get(v) : positional[Number(v) - 1],
                });
            }
        } else if (type === 'BUTTONS') {
            (c.buttons ?? []).forEach((b: MetaComponent, index: number) => {
                const bt = String(b.type).toUpperCase();
                if (bt === 'URL' && variablesIn(b.url ?? '').length) {
                    params.push({ key: `button.${index}`, component: 'button', kind: 'text', name: String(index), buttonIndex: index, example: b.example?.[0] });
                }
                if (bt === 'COPY_CODE') {
                    params.push({ key: `coupon.${index}`, component: 'button', kind: 'coupon_code', name: String(index), buttonIndex: index, example: b.example });
                }
            });
        }
    }
    return params;
}

/**
 * The `components` of a template send, from the values for each parameter.
 * Missing values are an error: Meta rejects a send with too few parameters.
 */
export function sendComponents(
    components: MetaComponent[],
    format: ParameterFormat,
    values: Record<string, ParamValue | undefined>,
): MetaComponent[] {
    const out: MetaComponent[] = [];
    const params = templateParams(components, format);
    const missing = params.filter((p) => values[p.key] === undefined || values[p.key] === '').map((p) => p.key);
    if (missing.length) throw new TemplateDraftError(`Missing template values: ${missing.join(', ')}`);

    const header = params.find((p) => p.component === 'header');
    if (header) {
        const value = values.header!;
        if (header.kind === 'text') {
            out.push({
                type: 'header',
                parameters: [{ type: 'text', ...(format === 'NAMED' ? { parameter_name: header.name } : {}), text: String(value) }],
            });
        } else if (header.kind === 'location') {
            out.push({ type: 'header', parameters: [{ type: 'location', location: value }] });
        } else {
            out.push({ type: 'header', parameters: [{ type: header.kind, [header.kind]: mediaRef(value) }] });
        }
    }
    const body = params.filter((p) => p.component === 'body');
    if (body.length) {
        out.push({
            type: 'body',
            parameters: body.map((p) => ({
                type: 'text',
                ...(format === 'NAMED' ? { parameter_name: p.name } : {}),
                text: String(values[p.key]),
            })),
        });
    }
    for (const p of params.filter((x) => x.component === 'button')) {
        out.push(
            p.kind === 'coupon_code'
                ? { type: 'button', sub_type: 'copy_code', index: p.buttonIndex, parameters: [{ type: 'coupon_code', coupon_code: String(values[p.key]) }] }
                : { type: 'button', sub_type: 'url', index: String(p.buttonIndex), parameters: [{ type: 'text', text: String(values[p.key]) }] },
        );
    }
    return out;
}

function mediaRef(value: ParamValue): { id: string } | { link: string } {
    if (typeof value === 'object' && 'mediaId' in value) return { id: value.mediaId };
    if (typeof value === 'object' && 'link' in value) return { link: value.link };
    throw new TemplateDraftError('The header needs an image, video or document.');
}

/** The template as the customer would read it, with values filled in where given. */
export function renderTemplate(
    components: MetaComponent[],
    values: Record<string, ParamValue | undefined> = {},
): { header: string | null; headerFormat: string | null; body: string; footer: string | null; buttons: string[] } {
    const fill = (text: string, prefix: string) =>
        text.replace(VAR, (whole, v: string) => {
            const value = values[prefix === 'header' ? 'header' : `${prefix}.${v}`];
            return typeof value === 'string' && value ? value : whole;
        });
    const find = (type: string) => components.find((c) => String(c.type).toUpperCase() === type);
    const header = find('HEADER');
    const headerFormat = header ? String(header.format).toUpperCase() : null;
    return {
        header: headerFormat === 'TEXT' ? fill(header!.text ?? '', 'header') : null,
        headerFormat,
        body: fill(find('BODY')?.text ?? '', 'body'),
        footer: find('FOOTER')?.text ?? null,
        buttons: (find('BUTTONS')?.buttons ?? []).map((b: MetaComponent) => b.text ?? 'Copy code'),
    };
}
