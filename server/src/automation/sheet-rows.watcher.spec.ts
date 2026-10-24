import { SheetRowsWatcher } from './sheet-rows.watcher';

describe('SheetRowsWatcher', () => {
    it('moves a sheet’s position only past rows whose events were recorded', async () => {
        const trigger = { subjectId: 's1', config: { phoneField: 'Phone' }, channel: { id: 'ch', platform: 'WHATSAPP' }, automation: { id: 'a1', organizationId: 'o' } };
        const prisma = { automationTrigger: { findMany: jest.fn(async () => [trigger]) } };
        const google = {
            newRows: jest.fn(async () => ({
                columns: [{ header: 'Phone', key: 'phone' }],
                rows: [
                    { number: 3, cells: ['+919800000001'] },
                    { number: 4, cells: ['+919800000002'] },
                    { number: 5, cells: ['+919800000003'] },
                ],
                end: 5,
            })),
            markRead: jest.fn(async () => undefined),
            noteSkipped: jest.fn(),
        };
        const hooks = { contactFor: jest.fn(async (_o: string, _c: unknown, digits: string) => ({ id: `c${digits}`, externalId: digits })) };
        const record = jest.fn(async (_db: unknown, input: { externalId: string }) => {
            if (input.externalId.endsWith(':4')) throw new Error('connection reset');
            return { id: `e-${input.externalId}` };
        });
        const jobs = { event: jest.fn() };
        const watcher = new SheetRowsWatcher(prisma as never, google as never, hooks as never, { record } as never, jobs as never, { get: () => 120 } as never);

        await watcher.tick();

        expect(jobs.event).toHaveBeenCalledTimes(1);
        // Row 4 failed: it and the rows after it are read again next time.
        expect(google.markRead).toHaveBeenCalledWith('s1', 3);
    });
});
