import { zonedParts, zonedTimeToUtc } from '../../common/utils/zoned-date.util';

/** Marketing messages from automations wait out the night in the store's time zone. */
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 9;

/** When a marketing send held at `now` may go out (09:00 store time), or null when it may go now. */
export function quietHoursEnd(now: Date, timeZone: string): Date | null {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour >= QUIET_UNTIL_HOUR && hour < QUIET_FROM_HOUR) return null;
    const { year, month, day } = zonedParts(now, timeZone);
    if (hour < QUIET_UNTIL_HOUR) return zonedTimeToUtc(year, month, day, timeZone, QUIET_UNTIL_HOUR);
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
    return zonedTimeToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), timeZone, QUIET_UNTIL_HOUR);
}
