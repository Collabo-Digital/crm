/**
 * Units of a Shopify order line still on the order once order edits are
 * taken off.
 *
 * Shopify keeps a line that an order edit removed in `line_items` with its
 * original `quantity`; only `current_quantity` drops, to 0 for a line taken
 * off entirely. Storing `quantity` put items the customer had dropped on the
 * invoice (issued and sent automatically), in order messages and in units
 * sold.
 *
 * `current_quantity` also leaves out refunded units. Those stay: the invoice
 * for the sale carries them and a credit note reverses them, so they are
 * added back from the order's refunds. A payload without `current_quantity`
 * (an older API version) keeps `quantity`.
 */
export function quantityAfterEdits(
  line: { id: unknown; quantity: number; current_quantity?: unknown },
  refunds: unknown,
): number {
  const current = Number(line.current_quantity);
  if (line.current_quantity === undefined || line.current_quantity === null || !Number.isFinite(current)) {
    return line.quantity;
  }

  let refunded = 0;
  for (const refund of Array.isArray(refunds) ? refunds : []) {
    const items: unknown = (refund as { refund_line_items?: unknown } | null)?.refund_line_items;
    for (const item of Array.isArray(items) ? items : []) {
      const { line_item_id, quantity } = (item ?? {}) as { line_item_id?: unknown; quantity?: unknown };
      if (String(line_item_id) === String(line.id)) refunded += Number(quantity) || 0;
    }
  }

  return Math.max(0, Math.min(line.quantity, current + refunded));
}
