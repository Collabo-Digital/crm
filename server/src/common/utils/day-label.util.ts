const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A chart day as the app writes dates everywhere else: day first, short
 * month ("21 Oct"). The analytics trend used to label days "10-21", which an
 * Indian owner reads as 10 May on the first twelve days of a month. Read in
 * UTC, like the day keys the buckets are built from.
 */
export function dayMonthLabel(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}
