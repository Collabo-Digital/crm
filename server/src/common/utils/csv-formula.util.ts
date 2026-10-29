/**
 * Make a CSV cell read as text in a spreadsheet.
 *
 * Excel and Google Sheets run a cell that starts with = + - @ (or with a tab
 * or carriage return) as a formula. Buyer names come from Shopify customers,
 * who type them on the storefront, so `=HYPERLINK(...)` in an export would
 * run on the merchant's or their accountant's machine. A leading apostrophe
 * makes the cell plain text.
 *
 * Plain numbers, negative ones included, are left alone so amounts stay
 * numeric.
 */
export function neutraliseCsvFormula(text: string): string {
  if (!/^[=+\-@\t\r]/.test(text) || /^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

/** One export row with every text cell made plain text; other values are left as they are. */
export function neutraliseCsvRow<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? neutraliseCsvFormula(value) : value]),
  ) as T;
}

/** A cell read back from one of our exports, without the apostrophe `neutraliseCsvFormula` added. */
export function restoreCsvFormulaText(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}
