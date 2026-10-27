import { contrastOnWhite, FILL, INK, paletteOf, tint } from './theme';

describe('the palette', () => {
    it('measures contrast against white the WCAG way', () => {
        expect(contrastOnWhite('#FFFFFF')).toBeCloseTo(1, 6);
        expect(contrastOnWhite('#000000')).toBeCloseTo(21, 6);
        expect(contrastOnWhite('#0F766E')).toBeGreaterThan(3);
        expect(contrastOnWhite('#F59E0B')).toBeLessThan(3);
    });

    it('tints a colour over white', () => {
        expect(tint('#0F766E', 0.1)).toBe('#E7F1F1');
        expect(tint('#000000', 0)).toBe('#FFFFFF');
    });

    it('Modern: the brand colour for the bar, the title and the header rule, and a tint behind the header and the grand total', () => {
        const palette = paletteOf('modern', '#0F766E');
        expect(palette).toMatchObject({ bar: '#0F766E', title: '#0F766E', headRule: '#0F766E', headFill: '#E7F1F1', totalFill: '#E7F1F1', grid: false, totalBorder: null });
    });

    it('a colour too light for text keeps the bar, the rule and a tint that still shows, and the title prints in ink', () => {
        const palette = paletteOf('modern', '#F59E0B');
        expect(palette.title).toBe(INK);
        expect(palette.bar).toBe('#F59E0B');
        expect(palette.headRule).toBe('#F59E0B');
        expect(contrastOnWhite(palette.headFill)).toBeGreaterThanOrEqual(1.1);
    });

    it('no brand colour: ink and light grey', () => {
        expect(paletteOf('modern', null)).toMatchObject({ bar: INK, title: INK, headRule: INK, headFill: FILL, totalFill: FILL });
    });

    it('Classic: ink only, a ruled grid, no bar, whatever the brand colour', () => {
        expect(paletteOf('classic', '#0F766E')).toMatchObject({ bar: null, title: INK, headRule: INK, headFill: FILL, totalBorder: INK, grid: true });
    });
});
