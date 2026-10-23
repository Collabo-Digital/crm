import { ChannelStatus } from '@prisma/client';
import { accountUpdateEffect } from './whatsapp-account-update.util';

describe('accountUpdateEffect', () => {
    it('marks a partner removal for phone inactivity with copy the merchant can act on', () => {
        const effect = accountUpdateEffect('PARTNER_REMOVED', 'PRIMARY_INACTIVITY')!;
        expect(effect.status).toBe(ChannelStatus.ERROR);
        expect(effect.pauseSends).toBe(true);
        expect(effect.lastError).toMatch(/hasn't been opened for about two weeks/);
        expect(effect.coexistence).toEqual({ state: 'disconnected', reason: 'PRIMARY_INACTIVITY' });
    });

    it('falls back to generic copy for an unknown removal reason', () => {
        expect(accountUpdateEffect('PARTNER_REMOVED', 'SOMETHING_NEW')!.lastError).toMatch(/Reconnect WhatsApp/);
    });

    it('pauses while a coexistence number is offboarded and resumes on reconnect', () => {
        const off = accountUpdateEffect('ACCOUNT_OFFBOARDED', null)!;
        expect(off).toMatchObject({ status: ChannelStatus.ERROR, pauseSends: true, coexistence: { state: 'reconnecting' } });
        const back = accountUpdateEffect('ACCOUNT_RECONNECTED', null)!;
        expect(back).toMatchObject({ status: ChannelStatus.CONNECTED, lastError: null, pauseSends: false });
    });

    it('leaves the channel alone for informational events', () => {
        expect(accountUpdateEffect('PARTNER_ADDED', null)).toBeNull();
        expect(accountUpdateEffect('MM_LITE_TERMS_SIGNED', null)).toBeNull();
        expect(accountUpdateEffect(null, null)).toBeNull();
    });
});
