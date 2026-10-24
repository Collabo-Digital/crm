import { AutomationService } from './automation.service';

describe('AutomationService: a sheet trigger going live', () => {
    const steps = [
        { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'sheet_row', sheetId: 'sh1', phoneField: 'Phone' } },
        { id: 'n', type: 'add_note', config: { text: 'New lead {{sheet.phone}}' } },
    ];
    function service(watchedByOthers: number) {
        const row = {
            id: 'a1',
            organizationId: 'o',
            status: 'PAUSED',
            version: 1,
            publishedVersionId: 'v1',
            definition: { steps },
            settings: { oncePerContact: 'ever' },
            platform: 'WHATSAPP',
            channelId: 'ch',
            triggers: [{ triggerType: 'crm.sheet.row', subjectId: 'sh1' }],
            publishedVersion: null,
        };
        const db = {
            automation: { findFirst: jest.fn(async () => row), update: jest.fn(async () => ({})) },
            automationTrigger: { count: jest.fn(async () => watchedByOthers), updateMany: jest.fn(async () => ({})), deleteMany: jest.fn(), upsert: jest.fn() },
            automationVersion: { create: jest.fn(async () => ({ id: 'v2' })) },
            googleSheet: { updateMany: jest.fn(async () => ({ count: 1 })), findMany: jest.fn(async () => [{ id: 'sh1' }]) },
            channelMedia: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
            $executeRaw: jest.fn(),
        };
        const prisma = { ...db, $transaction: jest.fn(async (arg: unknown) => (typeof arg === 'function' ? arg(db) : Promise.all(arg as unknown[]))) };
        const s = new AutomationService(prisma as never, {} as never);
        jest.spyOn(s, 'findOne').mockResolvedValue({} as never);
        return { s, db };
    }
    const viewer = { userId: 'u1' };

    it.each(['resume', 'publish'] as const)('on %s, reads an unwatched sheet from its end, so rows added meanwhile start nothing', async (how) => {
        const { s, db } = service(0);
        await s[how]('a1', 'o', viewer);
        expect(db.automationTrigger.count).toHaveBeenCalledWith({ where: expect.objectContaining({ triggerType: 'crm.sheet.row', subjectId: 'sh1', isActive: true }) });
        expect(db.googleSheet.updateMany).toHaveBeenCalledWith({ where: { id: 'sh1', organizationId: 'o' }, data: { seenRows: null } });
    });

    it.each(['resume', 'publish'] as const)('on %s, keeps the place of a sheet another live automation reads', async (how) => {
        const { s, db } = service(1);
        await s[how]('a1', 'o', viewer);
        expect(db.googleSheet.updateMany).not.toHaveBeenCalled();
    });
});
