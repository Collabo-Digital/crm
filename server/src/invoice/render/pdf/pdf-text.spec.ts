import { readCmap } from './pdf-text';

describe('readCmap', () => {
    it('reads bfchar pairs, both forms of bfrange, conjuncts and surrogate pairs', () => {
        const cmap = readCmap(`
            /CIDInit /ProcSet findresource begin
            2 beginbfchar
            <0003> <20B9>
            <0004> <D83D DE00>
            endbfchar
            2 beginbfrange
            <0010> <0012> <0041>
            <0020> <0022> [<0915> <0930 094D> <093F>]
            endbfrange
            endcmap
        `);
        expect(cmap.get(3)).toBe('₹');
        expect(cmap.get(4)).toBe('😀');
        expect([cmap.get(0x10), cmap.get(0x11), cmap.get(0x12)]).toEqual(['A', 'B', 'C']);
        expect([cmap.get(0x20), cmap.get(0x21), cmap.get(0x22)]).toEqual(['क', 'र्', 'ि']);
        expect(cmap.has(0x13)).toBe(false);
    });
});
