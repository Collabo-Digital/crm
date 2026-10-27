import type { DocumentTheme } from '../document-model';

export const INK = '#111827';
export const MUTED = '#6B7280';
/** Rules between rows and around blocks on Modern. */
export const RULE = '#E5E7EB';
/** Classic's grid, and the boxes on both themes. */
export const GRID = '#D1D5DB';
/** Light grey fills: Classic's header row and grand total, and Modern's when there is no brand colour. */
export const FILL = '#F3F4F6';

/** Status chips: a light fill with dark text of the same hue, legible in greyscale too. */
export const CHIP = {
    paid: { fill: '#D1FAE5', text: '#065F46' },
    due: { fill: '#FEF3C7', text: '#92400E' },
    neutral: { fill: '#F3F4F6', text: '#374151' },
    void: { fill: '#FEE2E2', text: '#991B1B' },
} as const;

export const WATERMARK = '#DC2626';

/** Every colour a document is drawn with, chosen once from its theme and brand colour. */
export interface Palette {
    /** The 4 pt bar across the top of every page; Classic has none. */
    bar: string | null;
    /** The title: the brand colour when it reads on white, else ink. */
    title: string;
    headFill: string;
    headText: string;
    /** The 1 pt rule under the table header. */
    headRule: string;
    totalFill: string;
    /** Classic boxes the grand total in ink. */
    totalBorder: string | null;
    /** Rules between rows and around blocks. */
    rule: string;
    /** Classic rules every cell. */
    grid: boolean;
}

/** sRGB relative luminance (WCAG 2), 0 for black to 1 for white. */
function luminance(hex: string): number {
    const channel = (offset: number) => {
        const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of a colour against white paper, from 1 to 21. */
export function contrastOnWhite(hex: string): number {
    return 1.05 / (luminance(hex) + 0.05);
}

/** The colour laid over white at `alpha` opacity, as an opaque `#RRGGBB`. */
export function tint(hex: string, alpha: number): string {
    const mix = (offset: number) =>
        Math.round(parseInt(hex.slice(offset, offset + 2), 16) * alpha + 255 * (1 - alpha))
            .toString(16)
            .padStart(2, '0');
    return `#${mix(1)}${mix(3)}${mix(5)}`.toUpperCase();
}

/**
 * The tint behind the table header and the grand total. 10% of a dark brand
 * colour shows clearly, but 10% of a light one (amber, pastel) is all but
 * white, so light colours get a stronger tint until the band shows.
 */
function bandTint(hex: string): string {
    let alpha = 0.1;
    while (alpha < 0.4 && contrastOnWhite(tint(hex, alpha)) < 1.1) alpha += 0.02;
    return tint(hex, alpha);
}

/**
 * Modern: the brand colour (ink when there is none) for the bar, the title,
 * the rule under the table header, and a tint behind the header and the grand
 * total. A colour under 3:1 against white never colours text: it keeps the
 * bar, the rule and the tints, and the title prints in ink.
 * Classic: ink only, a fully ruled grid and light grey fills, so it prints
 * cleanly in black and white.
 */
export function paletteOf(theme: DocumentTheme, brandColor: string | null): Palette {
    if (theme === 'classic') {
        return { bar: null, title: INK, headFill: FILL, headText: INK, headRule: INK, totalFill: FILL, totalBorder: INK, rule: GRID, grid: true };
    }
    const accent = brandColor ?? INK;
    const band = brandColor ? bandTint(brandColor) : FILL;
    return {
        bar: accent,
        title: contrastOnWhite(accent) >= 3 ? accent : INK,
        headFill: band,
        headText: '#374151',
        headRule: accent,
        totalFill: band,
        totalBorder: null,
        rule: RULE,
        grid: false,
    };
}
