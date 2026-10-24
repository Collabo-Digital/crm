import { ChannelStatus } from '@prisma/client';
import { RESTRICTION_ERRORS, accountUpdateEffect, channelChange, healthClearsRestriction } from './whatsapp-account-update.util';

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

    it('stops sending only when Meta disables the account', () => {
        const disabled = accountUpdateEffect('DISABLED_UPDATE', null, { ban_info: { waba_ban_state: ['DISABLE'], waba_ban_date: 'October 25, 2026' } })!;
        expect(disabled.status).toBe(ChannelStatus.ERROR);
        expect(RESTRICTION_ERRORS).toContain(disabled.lastError);
    });

    it('treats a planned disable and a violation as warnings that leave the number sending', () => {
        const planned = accountUpdateEffect('DISABLED_UPDATE', null, { ban_info: { waba_ban_state: ['SCHEDULE_FOR_DISABLE'] } })!;
        expect(planned.status).toBeNull();
        expect(planned.lastError).toMatch(/plans to disable/);
        const violation = accountUpdateEffect('ACCOUNT_VIOLATION', null, { violation_info: { violation_type: 'ADULT' } })!;
        expect(violation.status).toBeNull();
        expect(violation.lastError).toMatch(/policy violation .*\(adult\)/);
    });

    it('describes a restriction on starting conversations, with its end date, without blocking replies', () => {
        const effect = accountUpdateEffect('ACCOUNT_RESTRICTION', null, {
            restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1793000000 }],
        })!;
        expect(effect.status).toBeNull();
        expect(effect.lastError).toMatch(/^Meta has stopped this number from starting conversations until \d+ \w+ 2026/);
        expect(effect.lastError).toMatch(/Replies still work/);
    });

    it('reinstates a disabled number, but never hides an unrelated error', () => {
        const reinstated = accountUpdateEffect('DISABLED_UPDATE', null, { ban_info: { waba_ban_state: ['REINSTATE'] } })!;
        const disabledCopy = accountUpdateEffect('DISABLED_UPDATE', null, { ban_info: { waba_ban_state: ['DISABLE'] } })!.lastError!;
        expect(channelChange({ status: ChannelStatus.ERROR, lastError: disabledCopy }, reinstated)).toEqual({ status: ChannelStatus.CONNECTED, lastError: null });
        expect(channelChange({ status: ChannelStatus.ERROR, lastError: RESTRICTION_ERRORS[1] }, reinstated)).toEqual({ status: ChannelStatus.CONNECTED, lastError: null });
        expect(channelChange({ status: ChannelStatus.ERROR, lastError: 'Meta rejected this account’s access. Reconnect it in Settings → Channels.' }, reinstated)).toEqual({});
    });

    it('does not let a warning replace another problem the merchant must fix', () => {
        const warning = accountUpdateEffect('ACCOUNT_VIOLATION', null, {})!;
        expect(channelChange({ status: ChannelStatus.CONNECTED, lastError: null }, warning)).toEqual({ lastError: warning.lastError });
        expect(channelChange({ status: ChannelStatus.CONNECTED, lastError: 'Setup is incomplete: the number could not be registered. Use Retry setup on this channel.' }, warning)).toEqual({});
    });

    it('clears a restriction warning when Meta reports none left', () => {
        const lifted = accountUpdateEffect('ACCOUNT_RESTRICTION', null, { restriction_info: [] })!;
        const warning = accountUpdateEffect('ACCOUNT_RESTRICTION', null, { restriction_info: [{ restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION' }] })!.lastError!;
        expect(channelChange({ status: ChannelStatus.CONNECTED, lastError: warning }, lifted)).toEqual({ lastError: null });
    });

    it('lets the daily health check clear a restriction once Meta says the number can send', () => {
        expect(healthClearsRestriction('AVAILABLE')).toBe(true);
        expect(healthClearsRestriction('LIMITED')).toBe(true);
        expect(healthClearsRestriction('BLOCKED')).toBe(false);
        expect(healthClearsRestriction(undefined)).toBe(false);
    });

    it('leaves the channel alone for informational events', () => {
        expect(accountUpdateEffect('PARTNER_ADDED', null)).toBeNull();
        expect(accountUpdateEffect('MM_LITE_TERMS_SIGNED', null)).toBeNull();
        expect(accountUpdateEffect(null, null)).toBeNull();
    });
});
