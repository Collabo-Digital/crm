// ─── Shopify Product CSV Format ────────────────────────────────────────────
// Reference: https://help.shopify.com/en/manual/products/import-export/using-csv
//
// Multi-variant products span multiple rows that share a `Handle`. The first
// row of each handle group carries product-level fields (Title, Body, Vendor,
// Type, Tags, Published, Status, image rows...); subsequent rows for the same
// handle carry only variant + extra-image data.
//
// We support a pragmatic subset that round-trips back into Shopify Import:
// product fields, options 1-3, variant pricing/sku/barcode/weight/inventory,
// images via repeated rows. Cost-per-item rides on the variant. Out of scope:
// per-variant tax overrides, gift-card flag.

import { sanitizeProductHtml } from '../../common/utils/sanitize-product-html.util';

export const SHOPIFY_CSV_HEADERS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Fulfillment Service',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Requires Shipping',
  'Variant Taxable',
  'Variant Barcode',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'Variant Image',
  'Variant Weight Unit',
  'Cost per item',
  'Status',
] as const;

export type ShopifyCsvRow = Record<(typeof SHOPIFY_CSV_HEADERS)[number], string>;

// ─── Encode (CSV writer) ───────────────────────────────────────────────────

/** Quote a value if it contains a comma, quote, or newline. RFC 4180 escaping. */
function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Slugify a string into a Shopify-style handle: lowercase, alphanumeric + dash.
 * Leading/trailing dashes stripped, consecutive dashes collapsed.
 */
export function toHandle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 255) || 'product';
}

const WEIGHT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

function toGrams(weight: number | null | undefined, unit: string | null | undefined): number {
  if (weight == null || !Number.isFinite(weight)) return 0;
  const factor = WEIGHT_TO_GRAMS[(unit ?? 'kg').toLowerCase()] ?? 1;
  return Math.round(weight * factor);
}

/**
 * Build CSV rows for a list of products. The first row of each product carries
 * product-level fields; additional rows for variants (>1) and images (>1) only
 * fill the variant/image cells. Returns the full CSV body including header.
 */
export function buildShopifyCsv(
  products: Array<{
    title: string;
    bodyHtml: string | null;
    vendor: string | null;
    productType: string | null;
    tags: string[];
    status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
    publishedAt: Date | null;
    options: Array<{ name: string; values: string[] }>;
    variants: Array<{
      sku: string | null;
      barcode: string | null;
      price: number | string;
      compareAtPrice: number | string | null;
      cost: number | string | null;
      inventoryQuantity: number;
      trackQuantity: boolean;
      continueSellingWhenOutOfStock: boolean;
      weight: number | string | null;
      weightUnit: string | null;
      requiresShipping: boolean;
      taxable: boolean;
      option1: string | null;
      option2: string | null;
      option3: string | null;
    }>;
    images: Array<{ src: string; alt: string | null; position: number }>;
  }>,
): string {
  const lines: string[] = [SHOPIFY_CSV_HEADERS.map(csvEscape).join(',')];

  for (const p of products) {
    const handle = toHandle(p.title);
    const variants = p.variants.length > 0 ? p.variants : [];
    const images = p.images;

    // The number of rows for this product is max(variants, images) — we zip
    // them together. If a product has 5 variants and 2 images, we emit 5 rows
    // (image fields blank from row 3 onward).
    const rowCount = Math.max(variants.length, images.length, 1);

    for (let i = 0; i < rowCount; i++) {
      const v = variants[i];
      const img = images[i];
      const isFirstRow = i === 0;

      const row: Record<string, string> = {};
      // Handle is always set
      row['Handle'] = handle;

      if (isFirstRow) {
        row['Title'] = p.title;
        row['Body (HTML)'] = sanitizeProductHtml(p.bodyHtml ?? '');
        row['Vendor'] = p.vendor ?? '';
        row['Type'] = p.productType ?? '';
        row['Tags'] = (p.tags ?? []).join(', ');
        row['Published'] = p.status === 'ACTIVE' ? 'TRUE' : 'FALSE';
        row['Status'] = p.status.toLowerCase();
      }

      // Options (names appear on every variant row that has a value)
      const optionNames = p.options.map((o) => o.name);
      if (optionNames[0]) row['Option1 Name'] = optionNames[0];
      if (optionNames[1]) row['Option2 Name'] = optionNames[1];
      if (optionNames[2]) row['Option3 Name'] = optionNames[2];

      if (v) {
        row['Option1 Value'] = v.option1 ?? (optionNames[0] ? '' : 'Default Title');
        row['Option2 Value'] = v.option2 ?? '';
        row['Option3 Value'] = v.option3 ?? '';
        row['Variant SKU'] = v.sku ?? '';
        row['Variant Grams'] = String(toGrams(Number(v.weight ?? 0), v.weightUnit));
        row['Variant Inventory Tracker'] = v.trackQuantity ? 'shopify' : '';
        row['Variant Inventory Qty'] = String(v.inventoryQuantity);
        row['Variant Inventory Policy'] = v.continueSellingWhenOutOfStock ? 'continue' : 'deny';
        row['Variant Fulfillment Service'] = 'manual';
        row['Variant Price'] = String(v.price);
        row['Variant Compare At Price'] = v.compareAtPrice != null ? String(v.compareAtPrice) : '';
        row['Variant Requires Shipping'] = v.requiresShipping ? 'TRUE' : 'FALSE';
        row['Variant Taxable'] = v.taxable ? 'TRUE' : 'FALSE';
        row['Variant Barcode'] = v.barcode ?? '';
        row['Variant Weight Unit'] = v.weightUnit ?? '';
        row['Cost per item'] = v.cost != null ? String(v.cost) : '';
      }

      if (img) {
        row['Image Src'] = img.src;
        row['Image Position'] = String(img.position);
        row['Image Alt Text'] = img.alt ?? '';
      }

      lines.push(SHOPIFY_CSV_HEADERS.map((h) => csvEscape(row[h])).join(','));
    }
  }

  return lines.join('\r\n') + '\r\n';
}

// ─── Decode (CSV parser) ───────────────────────────────────────────────────

/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields, escaped quotes
 * (`""`), embedded commas, and CR/LF inside quoted fields. Returns an
 * array of cell-array rows. Empty trailing lines are dropped.
 *
 * Sufficient for Shopify's exports. For pathological inputs (mismatched
 * quotes, BOMs, encoding issues), swap in `papaparse` — interface stays the
 * same.
 */
export function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM if present
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell);
      cell = '';
      // Non-empty rows only
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
      // Skip CRLF as a single newline
      if (ch === '\r' && src[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }
    cell += ch;
    i++;
  }

  // Trailing cell / row
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  return rows;
}

/**
 * Parse a Shopify CSV into header-keyed row maps. Cells map header → value
 * for every row after the first. Unknown columns are kept; missing columns
 * are absent from the row map (no `undefined` in the values).
 */
export function parseShopifyCsv(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0];
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      const val = row[c] ?? '';
      if (val !== '') obj[key] = val;
    }
    out.push(obj);
  }
  return out;
}

// ─── Group rows by Handle into product candidates ──────────────────────────

export interface ParsedProductCandidate {
  handle: string;
  title: string;
  bodyHtml?: string;
  vendor?: string;
  productType?: string;
  tags: string[];
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  options: Array<{ name: string; values: string[]; position: number }>;
  variants: Array<{
    option1?: string;
    option2?: string;
    option3?: string;
    sku?: string;
    barcode?: string;
    price: number;
    compareAtPrice?: number;
    cost?: number;
    inventoryQuantity: number;
    trackQuantity: boolean;
    continueSellingWhenOutOfStock: boolean;
    weight?: number;
    weightUnit?: 'g' | 'kg' | 'oz' | 'lb';
    requiresShipping: boolean;
    taxable: boolean;
  }>;
  images: Array<{ src: string; alt?: string; position: number }>;
}

const TRUE_LITERALS = new Set(['true', 'yes', '1', 't']);
const isTrue = (v: string | undefined): boolean =>
  v != null && TRUE_LITERALS.has(v.trim().toLowerCase());

const numOrUndef = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Group raw header-mapped rows by `Handle` and assemble each handle's
 * variants + images + product-level fields into a single create-ready
 * candidate. Throws on missing Handle.
 */
export function groupRowsIntoProducts(
  rows: Array<Record<string, string>>,
): {
  products: ParsedProductCandidate[];
  errors: Array<{ row: number; handle?: string; message: string }>;
} {
  const errors: Array<{ row: number; handle?: string; message: string }> = [];
  const byHandle = new Map<string, ParsedProductCandidate>();

  rows.forEach((r, idx) => {
    const handle = (r['Handle'] ?? '').trim();
    if (!handle) {
      errors.push({ row: idx + 2, message: 'Missing Handle' }); // +2 = 1-based + header
      return;
    }

    let p = byHandle.get(handle);
    if (!p) {
      p = {
        handle,
        title: (r['Title'] ?? handle).trim(),
        bodyHtml: sanitizeProductHtml(r['Body (HTML)'] ?? '') || undefined,
        vendor: r['Vendor'] || undefined,
        productType: r['Type'] || undefined,
        tags: (r['Tags'] ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        status:
          (r['Status']?.toUpperCase() === 'DRAFT'
            ? 'DRAFT'
            : r['Status']?.toUpperCase() === 'ARCHIVED'
              ? 'ARCHIVED'
              : isTrue(r['Published']) || !r['Published']
                ? 'ACTIVE'
                : 'DRAFT') as 'ACTIVE' | 'DRAFT' | 'ARCHIVED',
        options: [],
        variants: [],
        images: [],
      };
      // Option types live on the first row of each handle.
      const optNames = [
        r['Option1 Name'],
        r['Option2 Name'],
        r['Option3 Name'],
      ].map((n) => (n ?? '').trim());
      optNames.forEach((name, i) => {
        if (name && name !== 'Title') {
          p!.options.push({ name, values: [], position: i + 1 });
        }
      });
      byHandle.set(handle, p);
    }

    // Variant row (any row with Variant Price → counts as a variant entry)
    if (r['Variant Price']) {
      const opt1 = (r['Option1 Value'] ?? '').trim() || undefined;
      const opt2 = (r['Option2 Value'] ?? '').trim() || undefined;
      const opt3 = (r['Option3 Value'] ?? '').trim() || undefined;
      // Track values back into the option-type lists so they're complete.
      if (opt1 && p.options[0] && !p.options[0].values.includes(opt1)) {
        p.options[0].values.push(opt1);
      }
      if (opt2 && p.options[1] && !p.options[1].values.includes(opt2)) {
        p.options[1].values.push(opt2);
      }
      if (opt3 && p.options[2] && !p.options[2].values.includes(opt3)) {
        p.options[2].values.push(opt3);
      }

      const grams = numOrUndef(r['Variant Grams']);
      const weightUnit = (r['Variant Weight Unit'] ?? '').toLowerCase() as 'g' | 'kg' | 'oz' | 'lb' | '';
      const weight =
        grams != null
          ? weightUnit === 'kg'
            ? grams / 1000
            : weightUnit === 'oz'
              ? grams / 28.3495
              : weightUnit === 'lb'
                ? grams / 453.592
                : grams
          : undefined;

      p.variants.push({
        option1: opt1,
        option2: opt2,
        option3: opt3,
        sku: r['Variant SKU'] || undefined,
        barcode: r['Variant Barcode'] || undefined,
        price: numOrUndef(r['Variant Price']) ?? 0,
        compareAtPrice: numOrUndef(r['Variant Compare At Price']),
        cost: numOrUndef(r['Cost per item']),
        inventoryQuantity: numOrUndef(r['Variant Inventory Qty']) ?? 0,
        trackQuantity:
          (r['Variant Inventory Tracker'] ?? '').toLowerCase() !== '' &&
          (r['Variant Inventory Tracker'] ?? '').toLowerCase() !== 'manual',
        continueSellingWhenOutOfStock:
          (r['Variant Inventory Policy'] ?? '').toLowerCase() === 'continue',
        weight,
        weightUnit:
          weightUnit && ['g', 'kg', 'oz', 'lb'].includes(weightUnit)
            ? (weightUnit as 'g' | 'kg' | 'oz' | 'lb')
            : undefined,
        requiresShipping: !r['Variant Requires Shipping'] || isTrue(r['Variant Requires Shipping']),
        taxable: !r['Variant Taxable'] || isTrue(r['Variant Taxable']),
      });
    }

    // Image row (any row with Image Src adds an image to the product)
    if (r['Image Src']) {
      p.images.push({
        src: r['Image Src'],
        alt: r['Image Alt Text'] || undefined,
        position: numOrUndef(r['Image Position']) ?? p.images.length + 1,
      });
    }
  });

  // Default-variant guarantee: a product with no variant rows (rare —
  // some CSVs only have product-level + images, no Variant Price) still
  // needs at least one default variant for our schema.
  for (const p of byHandle.values()) {
    if (p.variants.length === 0) {
      p.variants.push({
        price: 0,
        inventoryQuantity: 0,
        trackQuantity: true,
        continueSellingWhenOutOfStock: false,
        requiresShipping: true,
        taxable: true,
      });
    }
  }

  return { products: [...byHandle.values()], errors };
}
