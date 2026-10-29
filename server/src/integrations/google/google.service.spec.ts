import { GoogleService, rowHash } from './google.service';

describe('GoogleService reading new rows', () => {
    function service(seenRows: number | null, sheet: string[][], lastRowHash: string | null = seenRows ? rowHash(sheet[seenRows - 1] ?? []) : null) {
        const prisma = {
            googleSheet: {
                findUnique: jest.fn(async () => ({ id: 's1', organizationId: 'o', spreadsheetId: 'sp', tab: 'Leads', seenRows, lastRowHash })),
                update: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
        };
        // 'Leads'!A3:ZZ → the rows from the 3rd on; 'Leads'!A1:ZZ1 → the header.
        const values = jest.fn(async (_token: string, _id: string, range: string) => {
            const [, from, to] = /!A(\d+):ZZ(\d+)?$/.exec(range)!;
            return sheet.slice(Number(from) - 1, to ? Number(to) : undefined);
        });
        const redis = { get: jest.fn(async () => 'token') };
        const s = new GoogleService(prisma as never, {} as never, redis as never, { values } as never, {} as never);
        return { s, prisma, values };
    }
    const header = ['Name', 'Phone'];
    const row = (name: string, phone: string) => [name, phone];

    it('returns rows after the last one seen, and leaves moving past them to the caller', async () => {
        const meera = row('Meera', '+91 98000 00003');
        const { s, prisma } = service(2, [header, row('Asha', '1'), row('Ravi', '+91 98000 00002'), [], meera]);
        const fresh = await s.newRows('s1');
        expect(fresh.rows).toEqual([
            { number: 3, cells: ['Ravi', '+91 98000 00002'], hash: rowHash(['Ravi', '+91 98000 00002']) },
            { number: 5, cells: meera, hash: rowHash(meera) },
        ]);
        expect(fresh.end).toEqual({ number: 5, hash: rowHash(meera) });
        expect(fresh.columns.map((c) => c.key)).toEqual(['name', 'phone']);
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({
            where: { id: 's1', seenRows: 2 },
            data: expect.objectContaining({ seenRows: 2, lastRowHash: rowHash(row('Asha', '1')) }),
        });
    });

    it('reads the sheet once when nothing was added', async () => {
        const { s, values } = service(3, [header, row('Asha', '1'), row('Ravi', '2')]);
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: { number: 3, hash: rowHash(row('Ravi', '2')) } });
        expect(values).toHaveBeenCalledTimes(1);
    });

    it('notes the end of a sheet read for the first time, and starts nothing', async () => {
        const { s, prisma } = service(null, [header, row('Asha', '1')]);
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: { number: 2, hash: rowHash(row('Asha', '1')) } });
        expect(prisma.googleSheet.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ seenRows: 2, lastRowHash: rowHash(row('Asha', '1')) }) });
    });

    it('finds the last row read again when rows above it were deleted, and misses none of the rows added since', async () => {
        // Six rows were seen, Ravi's last; Asha and Bina were deleted and Chitra and Dev added before the next read.
        const ravi = row('Ravi', '6');
        const { s, prisma, values } = service(6, [header, row('Kiran', '4'), row('Lata', '5'), ravi, row('Chitra', '7'), row('Dev', '8')], rowHash(ravi));
        const fresh = await s.newRows('s1');
        expect(fresh.rows.map((r) => [r.number, r.cells[0]])).toEqual([[5, 'Chitra'], [6, 'Dev']]);
        expect(fresh.end).toEqual({ number: 6, hash: rowHash(row('Dev', '8')) });
        expect(fresh.columns.map((c) => c.key)).toEqual(['name', 'phone']);
        // The position follows Ravi up to row 4, so the caller's markRead can move it past Chitra and Dev.
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({ where: { id: 's1', seenRows: 6 }, data: expect.objectContaining({ seenRows: 4, lastRowHash: rowHash(ravi) }) });
        expect(values).toHaveBeenCalledTimes(2);
    });

    it('finds it again when only rows above it were deleted', async () => {
        const ravi = row('Ravi', '6');
        const { s, prisma } = service(6, [header, row('Kiran', '4'), row('Lata', '5'), ravi], rowHash(ravi));
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: { number: 4, hash: rowHash(ravi) } });
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({ where: { id: 's1', seenRows: 6 }, data: expect.objectContaining({ seenRows: 4 }) });
    });

    it('moves back to the end when the last row read was deleted, so the next new row is read', async () => {
        // Five rows were seen; the last two were deleted since.
        const { s, prisma, values } = service(5, [header, row('Asha', '1'), row('Ravi', '2')], rowHash(row('Meera', '4')));
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: { number: 3, hash: rowHash(row('Ravi', '2')) } });
        expect(prisma.googleSheet.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ seenRows: 3, lastRowHash: rowHash(row('Ravi', '2')) }) });
        expect(values).toHaveBeenCalledTimes(2);
    });

    it('reads on from the last row read when it was edited where it is', async () => {
        const { s, prisma } = service(3, [header, row('Asha', '1'), row('Ravi', '+91 98000 00002'), row('Meera', '3')], rowHash(row('Ravi', '2')));
        const fresh = await s.newRows('s1');
        expect(fresh.rows.map((r) => [r.number, r.cells[0]])).toEqual([[4, 'Meera']]);
        // Its new values are noted, so the next read is a single one again.
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({
            where: { id: 's1', seenRows: 3 },
            data: expect.objectContaining({ seenRows: 3, lastRowHash: rowHash(row('Ravi', '+91 98000 00002')) }),
        });
    });

    it('moves the position forward only, with the last row’s hash', async () => {
        const { s, prisma } = service(2, []);
        await s.markRead('s1', { number: 4, hash: 'h4' });
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({ where: { id: 's1', seenRows: { lt: 4 } }, data: { seenRows: 4, lastRowHash: 'h4' } });
    });
});
