import { Prisma } from '@prisma/client';
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

describe('AutomationService: the recommended pack’s system paths', () => {
    const steps = [
        { id: 'pk_trigger', type: 'trigger', config: { channel: 'whatsapp', event: 'order_fulfilled', skipPos: true } },
        { id: 'pk_send', type: 'send_message', config: { kind: 'template', templateSlot: 'order_shipped' } },
    ];
    function service(definition: unknown = { steps }) {
        const row = {
            id: 'a1', organizationId: 'o', status: 'DRAFT', version: 0, publishedVersionId: null, definition, settings: { oncePerContact: 'ever' },
            platform: 'WHATSAPP', channelId: 'ch', triggers: [], publishedVersion: null,
        };
        const db = {
            automation: { findFirst: jest.fn(async () => row), update: jest.fn(async () => ({})), create: jest.fn(async () => ({ id: 'a_new' })) },
            automationTrigger: { count: jest.fn(async () => 0), updateMany: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn() },
            automationVersion: { create: jest.fn(async () => ({ id: 'v1' })) },
            channelMedia: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
            $executeRaw: jest.fn(),
        };
        const prisma = { ...db, $transaction: jest.fn(async (arg: unknown) => (typeof arg === 'function' ? arg(db) : Promise.all(arg as unknown[]))) };
        return { s: new AutomationService(prisma as never, {} as never), db };
    }

    it('makes a draft nobody owns, checked like a saved draft', async () => {
        const { s, db } = service();
        await expect(s.createSystem('o', { packKey: 'order_shipped', name: 'Order shipped', description: 'd', channelId: 'ch', steps: steps as never, activateWhenReady: true })).resolves.toEqual({ id: 'a_new' });
        expect(db.automation.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ organizationId: 'o', ownerUserId: null, status: 'DRAFT', packKey: 'order_shipped', activateWhenReady: true, platform: 'WHATSAPP' }),
        }));
        await expect(s.createSystem('o', { packKey: 'x', name: 'x', description: 'x', channelId: 'ch', steps: [{ id: 'n', type: 'add_note', config: {} }] as never, activateWhenReady: false })).rejects.toThrow('first step must be the trigger');
        db.automation.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
        await expect(s.createSystem('o', { packKey: 'order_shipped', name: 'x', description: 'x', channelId: 'ch', steps: steps as never, activateWhenReady: true })).resolves.toBeNull();
    });

    it('publishes with nobody behind it, still refusing a draft with issues', async () => {
        const { s, db } = service();
        await expect(s.publishSystem('a1', 'o')).resolves.toEqual([]);
        expect(db.automationVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ publishedByUserId: null, version: 1 }) });
        expect(db.automation.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: expect.objectContaining({ status: 'ACTIVE', activateWhenReady: false }) });
        expect(db.automationTrigger.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ triggerType: 'crm.order.fulfilled', config: expect.objectContaining({ skipPos: true }) }) }));

        const broken = service({ steps: [steps[0], { id: 'pk_send', type: 'send_message', config: { kind: 'template', templateSlot: 'gone' } }] });
        await expect(broken.s.publishSystem('a1', 'o')).resolves.toEqual([expect.objectContaining({ code: 'template_slot_unknown' })]);
        expect(broken.db.automationVersion.create).not.toHaveBeenCalled();
    });
});
