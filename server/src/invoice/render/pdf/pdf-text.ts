import { inflateSync } from 'node:zlib';

/**
 * A PDF's text, page by page and line by line, for specs. With embedded
 * fonts the strings in a TJ array are glyph ids, not characters, so each
 * font's ToUnicode CMap (`beginbfchar` / `beginbfrange`) maps them back.
 * Every run is placed through the graphics and text matrices, then runs are
 * grouped into lines by baseline and read left to right, top to bottom, so a
 * spec can assert both the text and its order.
 *
 * Devanagari comes back in drawing order, not typing order: a vowel sign
 * drawn before its consonant (ि) is read first. Compare such text by its
 * characters, not as a string.
 */

export interface PdfPage {
    /** Top to bottom, each read left to right; no-break spaces read as spaces. */
    lines: string[];
    /** The lines joined with newlines. */
    text: string;
    /**
     * The runs in drawing order on one line: each block of text whole, even
     * where it wraps beside another column, so a wrapped sentence can be
     * matched as one string.
     */
    flow: string;
    /** Images drawn on the page: logos, signatures, QR codes. */
    images: PdfImage[];
    /** Every run of text where it was drawn: points from the page's bottom left, `size` the font size as drawn. */
    runs: Run[];
}

interface PdfObject {
    dict: string;
    stream: Buffer | null;
}

interface Font {
    toUnicode: Map<number, string>;
    /** Advance widths in thousandths of the font size, by glyph id. */
    widths: Map<number, number>;
    defaultWidth: number;
}

/** An image as embedded: pixels row by row (`DeviceRGB` three bytes each, `DeviceGray` one) when stored flate-compressed, else its encoded bytes (a JPEG). */
export interface PdfImage {
    width: number;
    height: number;
    colorSpace: string;
    filter: string;
    data: Buffer;
}

export interface Run {
    x: number;
    y: number;
    width: number;
    size: number;
    text: string;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: the matrix that applies `m` first. */
function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

/** Every `N 0 obj`, its dictionary and its stream inflated. Streams are skipped by their /Length, so binary data is never searched. */
function readObjects(pdf: Buffer): Map<number, PdfObject> {
    const source = pdf.toString('latin1');
    const objects = new Map<number, PdfObject>();
    const header = /(\d+) 0 obj\b/g;
    for (let match = header.exec(source); match; match = header.exec(source)) {
        const start = match.index + match[0].length;
        const end = source.indexOf('endobj', start);
        const streamAt = source.indexOf('stream', start);
        if (streamAt < 0 || streamAt > end) {
            objects.set(Number(match[1]), { dict: source.slice(start, end), stream: null });
            continue;
        }
        const dict = source.slice(start, streamAt);
        const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
        let offset = streamAt + 'stream'.length;
        if (source[offset] === '\r') offset++;
        if (source[offset] === '\n') offset++;
        const raw = pdf.subarray(offset, offset + length);
        objects.set(Number(match[1]), { dict, stream: dict.includes('/FlateDecode') ? inflateSync(raw) : raw });
        header.lastIndex = offset + length;
    }
    return objects;
}

/** UTF-16BE hex, possibly several code units ("<0930 094D>" for a conjunct). */
function utf16(hex: string): string {
    const clean = hex.replace(/\s+/g, '');
    let text = '';
    for (let i = 0; i + 4 <= clean.length; i += 4) text += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    return text;
}

/** A ToUnicode CMap: glyph id to text, from `bfchar` pairs and both forms of `bfrange`. */
export function readCmap(cmap: string): Map<number, string> {
    const map = new Map<number, string>();
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const [, code, target] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(code, 16), utf16(target));
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const [, lo, hi, target] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
            const first = parseInt(lo, 16);
            const last = parseInt(hi, 16);
            if (target.startsWith('[')) {
                const targets = [...target.matchAll(/<([0-9a-fA-F\s]+)>/g)].map((m) => utf16(m[1]));
                for (let code = first; code <= last; code++) map.set(code, targets[code - first] ?? '');
            } else {
                // One start value: its last code unit counts up through the range.
                const base = utf16(target.slice(1, -1));
                for (let code = first; code <= last; code++) {
                    map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + code - first));
                }
            }
        }
    }
    return map;
}

/** `/W [0 [600 572 …] 40 [260]]`: consecutive widths from a start id. */
function readWidths(dict: string): Map<number, number> {
    const widths = new Map<number, number>();
    const w = /\/W\s*\[([\s\S]*?\])\s*\]/.exec(dict);
    if (!w) return widths;
    for (const [, start, list] of w[1].matchAll(/(\d+)\s*\[([^\]]*)\]/g)) {
        list.trim()
            .split(/\s+/)
            .forEach((width, i) => widths.set(Number(start) + i, Number(width)));
    }
    return widths;
}

function readFont(objects: Map<number, PdfObject>, id: number): Font {
    const dict = objects.get(id)?.dict ?? '';
    const cmapId = /\/ToUnicode (\d+) 0 R/.exec(dict)?.[1];
    const descendantId = /\/DescendantFonts\s*\[\s*(\d+) 0 R/.exec(dict)?.[1];
    const descendant = descendantId ? (objects.get(Number(descendantId))?.dict ?? '') : '';
    return {
        toUnicode: readCmap(cmapId ? (objects.get(Number(cmapId))?.stream?.toString('latin1') ?? '') : ''),
        widths: readWidths(descendant),
        defaultWidth: Number(/\/DW (\d+)/.exec(descendant)?.[1] ?? 1000),
    };
}

/** PDF content tokens: arrays, hex and literal strings, names, numbers and operators. */
const TOKEN = /\s*(?:(\[)|(\])|<<|>>|<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)|\/([^\s/[\]<>()]+)|([-+]?(?:\d+\.?\d*|\.\d+))|([A-Za-z'"*]+))/y;

type Operand = number | string | { hex: string } | Operand[];

function readRuns(content: string, fontByName: (name: string) => Font | undefined): Run[] {
    const runs: Run[] = [];
    const stack: Operand[] = [];
    const arrays: Operand[][] = [];
    // q and Q save and restore the graphics state, which holds the font as well as the matrix.
    const saved: Array<{ ctm: Matrix; font: Font | undefined; size: number }> = [];
    let ctm: Matrix = IDENTITY;
    // The text matrix moves along a line as glyphs are shown; Td steps from the start of the line.
    let tm: Matrix = IDENTITY;
    let lineStart: Matrix = IDENTITY;
    let font: Font | undefined;
    let size = 0;

    const push = (operand: Operand) => (arrays.length ? arrays[arrays.length - 1].push(operand) : stack.push(operand));
    const show = (parts: Operand[]) => {
        if (!font) return;
        let text = '';
        let advance = 0;
        // Where the last visible glyph ends: a line's trailing space is drawn but takes no room.
        let inked = 0;
        for (const part of parts) {
            if (typeof part === 'number') advance -= (part / 1000) * size;
            else if (typeof part === 'object' && 'hex' in part) {
                const hex = part.hex.replace(/\s+/g, '');
                for (let i = 0; i + 4 <= hex.length; i += 4) {
                    const glyph = parseInt(hex.slice(i, i + 4), 16);
                    const char = font.toUnicode.get(glyph) ?? '';
                    text += char;
                    advance += ((font.widths.get(glyph) ?? font.defaultWidth) / 1000) * size;
                    if (char.trim()) inked = advance;
                }
            }
        }
        const at = multiply(tm, ctm);
        const scale = Math.hypot(at[0], at[1]);
        runs.push({ x: at[4], y: at[5], width: inked * scale, size: size * scale, text });
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
    };

    for (let at = 0; at < content.length; ) {
        TOKEN.lastIndex = at;
        const match = TOKEN.exec(content);
        // Anything unrecognised is stepped over, never allowed to end the page early.
        if (!match || !match[0]) {
            at++;
            continue;
        }
        at = TOKEN.lastIndex;
        const [, open, close, hex, literal, name, number, operator] = match;
        if (open) arrays.push([]);
        else if (close) push(arrays.pop() ?? []);
        else if (hex !== undefined) push({ hex });
        else if (literal !== undefined) push(literal);
        else if (name !== undefined) push(name);
        else if (number !== undefined) push(Number(number));
        else if (operator) {
            const numbers = stack.filter((operand): operand is number => typeof operand === 'number');
            const six = numbers.slice(-6) as Matrix;
            switch (operator) {
                case 'q':
                    saved.push({ ctm, font, size });
                    break;
                case 'Q':
                    ({ ctm, font, size } = saved.pop() ?? { ctm: IDENTITY, font, size });
                    break;
                case 'cm':
                    ctm = multiply(six, ctm);
                    break;
                case 'BT':
                    tm = lineStart = IDENTITY;
                    break;
                case 'Tm':
                    tm = lineStart = six;
                    break;
                case 'Td':
                    tm = lineStart = multiply([1, 0, 0, 1, numbers[numbers.length - 2], numbers[numbers.length - 1]], lineStart);
                    break;
                case 'Tf': {
                    const name = stack[stack.length - 2];
                    font = typeof name === 'string' ? fontByName(name) : undefined;
                    size = numbers[numbers.length - 1];
                    break;
                }
                case 'TJ':
                    show((stack[stack.length - 1] as Operand[]) ?? []);
                    break;
                case 'Tj': {
                    const operand = stack[stack.length - 1];
                    if (operand !== undefined) show([operand]);
                    break;
                }
            }
            stack.length = 0;
        }
    }
    return runs;
}

/** A new line, a step back to the left, or a visible gap between two runs reads as a space. */
const gapBetween = (before: Run, after: Run) =>
    Math.abs(before.y - after.y) >= 1.5 || after.x < before.x || after.x - (before.x + before.width) > after.size * 0.15;

function joinRuns(runs: Run[]): string {
    let text = '';
    runs.forEach((run, i) => {
        if (i && gapBetween(runs[i - 1], run) && !text.endsWith(' ') && !run.text.startsWith(' ')) text += ' ';
        text += run.text;
    });
    return text.replace(/\u00a0/g, ' ').trim();
}

/** Runs on one baseline become a line, read left to right. */
function toLines(runs: Run[]): string[] {
    const sorted = runs.filter((run) => run.text).sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Run[][] = [];
    for (const run of sorted) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line[0].y - run.y) < 1.5) line.push(run);
        else lines.push([run]);
    }
    return lines.map((line) => joinRuns(line.sort((a, b) => a.x - b.x)));
}

function readImage(object: PdfObject | undefined): PdfImage {
    const dict = object?.dict ?? '';
    const number = (key: string) => Number(new RegExp(`/${key} (\\d+)`).exec(dict)?.[1] ?? 0);
    return {
        width: number('Width'),
        height: number('Height'),
        colorSpace: /\/ColorSpace \/(\w+)/.exec(dict)?.[1] ?? '',
        filter: /\/Filter \/(\w+)/.exec(dict)?.[1] ?? '',
        data: object?.stream ?? Buffer.alloc(0),
    };
}

/** The text of every page of a PDF made by react-pdf (pdfkit): one flat page tree, fonts named per page. */
export function readPdfText(pdf: Buffer): PdfPage[] {
    const objects = readObjects(pdf);
    const fonts = new Map<number, Font>();
    const fontAt = (id: number) => {
        if (!fonts.has(id)) fonts.set(id, readFont(objects, id));
        return fonts.get(id)!;
    };
    const root = [...objects.values()].find((object) => /\/Type\s*\/Pages\b/.test(object.dict) && /\/Kids/.test(object.dict) && !/\/Parent/.test(object.dict));
    const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(root?.dict ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
    return kids.map((id) => {
        const page = objects.get(id)!.dict;
        const resourcesId = /\/Resources (\d+) 0 R/.exec(page)?.[1];
        const resources = resourcesId ? (objects.get(Number(resourcesId))?.dict ?? '') : page;
        const fontDict = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? '';
        const named = new Map([...fontDict.matchAll(/\/([^\s/]+)\s+(\d+) 0 R/g)].map(([, name, ref]) => [name, Number(ref)]));
        const contentIds = [...(/\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
        const content = contentIds.map((ref) => objects.get(ref)?.stream?.toString('latin1') ?? '').join('\n');
        const runs = readRuns(content, (name) => {
            const ref = named.get(name);
            return ref === undefined ? undefined : fontAt(ref);
        });
        const lines = toLines(runs);
        const xObjects = /\/XObject\s*<<([^>]*)>>/.exec(resources)?.[1] ?? '';
        return {
            lines,
            text: lines.join('\n'),
            flow: joinRuns(runs.filter((run) => run.text)).replace(/ {2,}/g, ' '),
            images: [...xObjects.matchAll(/(\d+) 0 R/g)].map(([, ref]) => readImage(objects.get(Number(ref)))),
            runs: runs.filter((run) => run.text),
        };
    });
}
