import { isOpen, parseInboxSettings, validateInboxSettings } from './inbox-settings.schema';

describe('inbox settings', () => {
    it('fills every section with defaults', () => {
        const s = parseInboxSettings({});
        expect(s.businessHours.days).toHaveLength(5);
        expect(s.welcome).toMatchObject({ enabled: false, cooldownHours: 24 });
        expect(s.spam).toEqual({ enabled: true, tag: 'spam', blockOnWhatsApp: false });
        expect(parseInboxSettings({ welcome: { cooldownHours: -1 } }).welcome.cooldownHours).toBe(24);
    });

    it('refuses a day that closes before it opens', () => {
        expect(() => validateInboxSettings({ businessHours: { enabled: true, days: [{ day: 1, open: '18:00', close: '09:00' }] } })).toThrow('close after');
    });

    it('reads business hours in the organization’s own time zone', () => {
        const hours = validateInboxSettings({ businessHours: { enabled: true, days: [{ day: 4, open: '09:00', close: '18:00' }] } }).businessHours;
        // Thursday 23 Oct 2026, 04:00 UTC is 09:30 in Kolkata and midnight in New York.
        const at = new Date('2026-10-23T04:00:00Z');
        expect(new Date(at).getUTCDay()).toBe(5);
        expect(isOpen(hours, 'Asia/Kolkata', new Date('2026-10-22T04:00:00Z'))).toBe(true);
        expect(isOpen(hours, 'America/New_York', new Date('2026-10-22T04:00:00Z'))).toBe(false);
        expect(isOpen(hours, 'Asia/Kolkata', new Date('2026-10-22T13:00:00Z'))).toBe(false);
        expect(isOpen({ ...hours, enabled: false }, 'Asia/Kolkata', at)).toBe(true);
    });
});
