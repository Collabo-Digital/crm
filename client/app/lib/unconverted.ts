/**
 * The note under a money total that had to leave orders out because their
 * currency rate is not known yet. One wording on every screen, so the
 * dashboard and the Orders page read the same, and plain enough for a shop
 * that only ever sells in rupees.
 */
export function unconvertedNote(count: number, noun: "order" | "bill" = "order"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"} not counted yet (currency rate pending)`;
}
