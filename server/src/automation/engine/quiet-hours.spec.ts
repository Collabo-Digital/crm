import { quietHoursEnd } from './quiet-hours';

describe('quietHoursEnd', () => {
    const IST = 'Asia/Kolkata';
    const at = (iso: string) => new Date(iso);

    it('lets marketing out from 09:00 to 21:00 store time', () => {
        expect(quietHoursEnd(at('2026-10-26T03:30:00Z'), IST)).toBeNull(); // 09:00 IST
        expect(quietHoursEnd(at('2026-10-26T15:29:59Z'), IST)).toBeNull(); // 20:59:59 IST
    });

    it('holds it overnight until 09:00 store time', () => {
        // 21:00 IST → 09:00 IST the next day.
        expect(quietHoursEnd(at('2026-10-26T15:30:00Z'), IST)).toEqual(at('2026-10-27T03:30:00Z'));
        // 23:50 IST, across the UTC date line of the store's day.
        expect(quietHoursEnd(at('2026-10-26T18:20:00Z'), IST)).toEqual(at('2026-10-27T03:30:00Z'));
        // 02:00 IST → 09:00 the same day.
        expect(quietHoursEnd(at('2026-10-26T20:30:00Z'), IST)).toEqual(at('2026-10-27T03:30:00Z'));
    });

    it('reads the hour in the store’s own zone, daylight saving included', () => {
        // 22:00 in New York (EDT, UTC−4) is 02:00 UTC: held until 09:00 EDT.
        expect(quietHoursEnd(at('2026-07-01T02:00:00Z'), 'America/New_York')).toEqual(at('2026-07-01T13:00:00Z'));
        // 08:00 London in winter (UTC) → 09:00.
        expect(quietHoursEnd(at('2026-12-01T08:00:00Z'), 'Europe/London')).toEqual(at('2026-12-01T09:00:00Z'));
        expect(quietHoursEnd(at('2026-12-01T12:00:00Z'), 'Europe/London')).toBeNull();
    });
});
