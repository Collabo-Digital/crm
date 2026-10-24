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
