import { Readable } from 'stream';
import { UserRole } from '@prisma/client';
import { InboxService } from './inbox.service';

/**
 * A template sent with a header file (the till's bill PDF, an automation's
 * GST invoice) shows that file in the thread: the message view gives it a
 * signed link, as a media message's file has, whatever Meta did with the
 * message, and the link serves the file.
 */

const viewer = { userId: 'u1', role: UserRole.OWNER, grants: [], teamIds: [] };
const SECRET = 'link-secret';

function template(over: Record<string, unknown> = {}) {
    return {
        id: 'msg_bill', direction: 'OUTBOUND', kind: 'TEMPLATE', source: 'SYSTEM', text: 'Hi Asha, your bill #M1042 is ready.',
        status: 'SENT', createdAt: new Date('2026-10-27T05:00:00Z'), sentAt: new Date('2026-10-27T05:00:01Z'), deliveredAt: null, readAt: null,
        failedAt: null, errorCode: null, errorMessage: null, imported: false, editedAt: null, revokedAt: null, reactions: null,
        templateName: 'collabo_store_bill_v2', sentByUserId: null, replyToMessageId: null, externalId: 'wamid.1',
        body: { payload: { type: 'template', name: 'collabo_store_bill_v2', language: 'en' } },
        media: { storageKey: 'org1/bill.pdf', mime: 'application/pdf', filename: 'Bill-M1042.pdf', kind: 'document' },
        ...over,
    };
}

function build(rows: Array<Record<string, unknown>>) {
    const prisma = {
        conversation: { findFirst: jest.fn(async () => ({ id: 'c1', channelId: 'ch1', platform: 'WHATSAPP', contact: {}, channel: {}, assignedUser: null, team: null })) },
        message: {
            findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => (where.inReplyToExternalId ? [] : [...rows].reverse())),
            findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        },
        user: { findMany: jest.fn(async () => []) },
        conversationNote: { findMany: jest.fn(async () => []) },
    };
    const storage = { open: jest.fn(async () => ({ stream: Readable.from(['%PDF-1.3']), size: 8 })) };
    const none = {} as never;
    const service = new InboxService(prisma as never, none, storage as never, none, none, none, none, none, none, none, none, none, { get: () => SECRET } as never);
    return { service, storage };
}

const linkOf = (url: string) => {
    const u = new URL(url, 'http://api.local');
    return { path: u.pathname, exp: u.searchParams.get('exp') ?? undefined, sig: u.searchParams.get('sig') ?? undefined };
};

describe('InboxService — a template’s header file in the thread', () => {
    it.each(['SENT', 'FAILED'])('a %s template comes with its file and a signed link to it', async (status) => {
        const { service, storage } = build([template({ status, ...(status === 'FAILED' ? { errorCode: '131042', errorMessage: 'Payment issue', failedAt: new Date() } : {}) })]);
        const { messages } = await service.listMessages('org1', viewer, 'c1', {});
        expect(messages[0]).toMatchObject({ kind: 'TEMPLATE', status, templateName: 'collabo_store_bill_v2' });
        expect(messages[0].media).toEqual({
            mime: 'application/pdf',
            filename: 'Bill-M1042.pdf',
            size: null,
            voice: false,
            durationMs: null,
            kind: 'document',
            url: expect.stringMatching(/^\/inbox\/media\/msg_bill\?exp=\d+&sig=[\w-]+$/),
            pending: false,
            error: null,
        });
        const link = linkOf(messages[0].media!.url!);
        const file = await service.openMedia('msg_bill', link.exp, link.sig);
        expect(storage.open).toHaveBeenCalledWith('org1/bill.pdf');
        expect(file).toMatchObject({ mime: 'application/pdf', filename: 'Bill-M1042.pdf', size: 8 });
    });

    it('a template without a header file has none, as before', async () => {
        const { service } = build([template({ media: null })]);
        const { messages } = await service.listMessages('org1', viewer, 'c1', {});
        expect(messages[0].media).toBeNull();
    });

    it('a media message’s file is unchanged, with no kind of its own', async () => {
        const { service } = build([template({ kind: 'DOCUMENT', media: { storageKey: 'org1/doc.pdf', mime: 'application/pdf', filename: 'Price list.pdf' } })]);
        const { messages } = await service.listMessages('org1', viewer, 'c1', {});
        expect(messages[0].media).toMatchObject({ filename: 'Price list.pdf', kind: null, url: expect.stringMatching(/^\/inbox\/media\/msg_bill\?/) });
    });
});
