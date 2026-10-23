/**
 * Snooze presets.
 *
 * Fixed options rather than a date picker: in practice an agent snoozes to
 * "after lunch" or "next week", not to a specific minute. Offsets are computed
 * at click time, not at module load, so "Tomorrow 9am" is right regardless of
 * how long the tab sat open.
 */
export const SNOOZE_PRESETS: { label: string; resolve: () => Date }[] = [
  { label: "1 hour", resolve: () => new Date(Date.now() + 60 * 60_000) },
  { label: "3 hours", resolve: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: "Tomorrow 9am",
    resolve: () => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    },
  },
  {
    label: "Next Monday",
    resolve: () => {
      const date = new Date();
      // getDay(): 0 = Sunday. Always lands on the NEXT Monday, never today.
      const daysUntilMonday = (8 - date.getDay()) % 7 || 7;
      date.setDate(date.getDate() + daysUntilMonday);
      date.setHours(9, 0, 0, 0);
      return date;
    },
  },
];
