import { FAILURES_BEFORE_PAUSE, FAILURE_PAUSE_MS, clearRecipientFailures, isRecipientFailure, noteRecipientFailure } from './recipient-failures';

describe('recipient failures', () => {
    it('counts only failures that are the person’s doing', () => {
        expect(isRecipientFailure(131026)).toBe(true); // WhatsApp: undeliverable
        expect(isRecipientFailure(551)).toBe(true); // blocked / not available
        expect(isRecipientFailure(551, 1545041)).toBe(true);
        expect(isRecipientFailure(200, 1545041)).toBe(true);
        expect(isRecipientFailure(10, 2018108)).toBe(true);
        expect(isRecipientFailure(100, 2018001)).toBe(true);
        expect(isRecipientFailure(100, 2534014)).toBe(true);

        // The account's problems: token, payment, template, window, rate limits, unknown.
        for (const [code, subcode] of [[190], [131042], [132015], [131047], [10, 2018278], [10, 2534022], [100, 2534029], [200, 2534041], [131056], [4], [100], [200], [undefined]] as Array<[number | undefined, number?]>) {
            expect(isRecipientFailure(code, subcode)).toBe(false);
        }
    });

    function db(start: number) {
        const contact = { consecutiveFailures: start, mutedUntil: null as Date | null };
        const channelContact = {
            update: jest.fn(async ({ data }: { data: { consecutiveFailures?: { increment: number }; mutedUntil?: Date } }) => {
                if (data.consecutiveFailures) contact.consecutiveFailures += data.consecutiveFailures.increment;
                if (data.mutedUntil) contact.mutedUntil = data.mutedUntil;
                return { consecutiveFailures: contact.consecutiveFailures };
            }),
            updateMany: jest.fn(async () => ({ count: 1 })),
        };
        return { contact, client: { channelContact } as never, channelContact };
    }

    it(`pauses automations for a day at the ${FAILURES_BEFORE_PAUSE}rd failure in a row, and again at each one after`, async () => {
        const at = new Date('2026-10-27T10:00:00Z');
        const d = db(FAILURES_BEFORE_PAUSE - 2);
        await noteRecipientFailure(d.client, 'c1', at);
        expect(d.contact.mutedUntil).toBeNull();
        await noteRecipientFailure(d.client, 'c1', at);
        expect(d.contact.mutedUntil).toEqual(new Date(at.getTime() + FAILURE_PAUSE_MS));

        const later = new Date(at.getTime() + FAILURE_PAUSE_MS + 60_000);
        await noteRecipientFailure(d.client, 'c1', later);
        expect(d.contact.mutedUntil).toEqual(new Date(later.getTime() + FAILURE_PAUSE_MS));
    });

    it('clears the count and any pause only where there is something to clear', async () => {
        const d = db(0);
        await clearRecipientFailures(d.client, 'c1');
        expect(d.channelContact.updateMany).toHaveBeenCalledWith({
            where: { id: 'c1', OR: [{ consecutiveFailures: { gt: 0 } }, { mutedUntil: { not: null } }] },
            data: { consecutiveFailures: 0, mutedUntil: null },
        });
    });
});
