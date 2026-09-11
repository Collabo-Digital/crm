# Design system

```
Design tokens  →  CSS variables  →  Tailwind utilities
                                          ↓
                                  ui/ primitives
                                          ↓
                             components/app/ business components
                                          ↓
                                       routes
```

**Tailwind is not the design system.** The tokens in `app/app.css` are. Tailwind is
how they reach the markup.

---

## Rules

1. **Never write a hex in a component.** If a colour isn't a token, add the token.
2. **Never write a bare palette utility.** `text-gray-900 dark:text-gray-100` is
   `text-foreground`. Tokens make almost all of the app's ~700 `dark:` variants
   unnecessary.
3. **Never write a numeric or arbitrary size.** Not `text-sm`, not `text-[24px]`,
   not `rounded-[13px]`. Write the *role*.
4. **Buttons come from `<Button>`.** Panels from `<SectionCard>`, simple surfaces
   from `<Card>`, page headers from `<PageHeader>`.
5. **`style={{}}` is for computed values only** — chart geometry, skeleton widths.

Layout is the exception to rule 3: `flex`, `grid`, `gap-4`, `justify-between` and
friends belong inline in the markup. They're per-composition, not design decisions.
Just keep to Tailwind's spacing scale (`gap-4`, never `gap-[17px]`).

**Paper is not a surface.** Rules 1 and 2 stop at anything that represents
printed output — the label artwork in `components/app/labels/`, the package and
order slips. Those keep literal `bg-white`, `text-black`, `fill="#000000"`, and
their geometry stays in inline millimetres (rule 5 covers it: it is computed, and
Tailwind cannot emit runtime `mm` values anyway). Migrating them to `bg-card` /
`text-foreground` would render a black sticker in dark mode and, because
`.label-cell` carries `print-color-adjust: exact`, risk printing one. The rules
resume at the edge of the page: everything around the preview is tokens.

---

## Type roles

| Role | px / leading / weight | Use for |
|---|---|---|
| `text-micro`      | 10 / 14       | badge and dot labels |
| `text-caption`    | 12 / 16       | helper text, meta, timestamps |
| `text-label`      | 13 / 18 / 500 | form labels |
| `text-body`       | 14 / 20       | body copy, table cells |
| `text-section`    | 16 / 24 / 600 | section and card titles |
| `text-subhead`    | 20 / 28 / 600 | sub-headings |
| `text-page-title` | 24 / 32 / 600 | page H1 |
| `text-stat`       | 28 / 36 / 600 | KPI numerals |

Tailwind's own `text-xs`/`sm`/`base`/`lg`/`xl`/`2xl` still resolve (12/14/16/18/20/24)
for files not yet migrated. **They are forbidden in new code.**

### ⚠️ Two traps

**Size, leading and weight travel together.** The compiled rule is
`font-weight: var(--tw-font-weight, 600)` — a *fallback*. Putting `font-bold` or
`leading-none` on the same element silently beats the token, with no conflict for
`cn()` to resolve. An element using a type role must not also carry `font-*` or
`leading-*` unless it is deliberately overriding.

**The role list in `lib/utils.ts` must stay in sync with `app.css`.** `tailwind-merge`
classifies any unrecognised `text-*` as a *colour* (its catch-all, so custom colour
names work), so an unregistered role gets deleted by `cn()` whenever it sits beside a
text colour — at runtime, with no build error. Add a role to `app.css` **and** to the
`font-size` class group in `lib/utils.ts`, or it will be inert.

---

## Font roles

`font-sans` (Geist) · `font-heading` · `font-display` (Baumans — wordmark only) ·
`font-mono` (print receipts, tabular figures)

Renaming a font or colour token leaves the old class silently inert — Tailwind emits
nothing for an unknown class rather than erroring. **Grep for the old name after any
token rename.**

---

## Colour roles

**Brand** — `brand`, `brand-hover`, `brand-foreground`, `brand-strong` (accent text;
flips to lime in dark for contrast), `brand-strong-hover`, `brand-forest` (fixed in
both themes — for gradients and graphics that must stay forest), `brand-deep`,
`brand-mid`

**Surface** — `background`, `card`, `popover`, `muted`, `surface-sunken` (app shell),
`ink` (fixed black in both themes — the black-on-lime pairings), `ink-foreground`
(fixed white, for text on an `ink` fill)

**Status** — `success`, `warning` (amber), `warning-strong` (orange), `danger`, `info`
— each with a `-subtle` background companion

---

## Radius

`rounded-sm | md | lg | xl` only. `rounded-lg` is 10px. **Do not change `--radius`** —
it shifts every corner in the app.

---

## Migration recipe

| Find | Replace |
|---|---|
| `bg-[#CEF17B]` / `bg-[#cdff8c]` | `bg-brand` |
| `hover:bg-[#BADE6F]` / `hover:bg-[#b8e67d]` | `hover:bg-brand-hover` |
| `text-[#084734] hover:text-[#3d6000]` | `text-brand-strong hover:text-brand-strong-hover` |
| `bg-white dark:bg-gray-900` | `bg-card` |
| `bg-[#f1f7fa] dark:bg-gray-950` | `bg-surface-sunken` |
| `text-gray-900 dark:text-gray-100` | `text-foreground` |
| `border-gray-100 dark:border-gray-700` | `border-border` |
| `bg-gray-100 dark:bg-gray-800` | `bg-muted` |
| `text-red-600 bg-red-50` | `text-danger bg-danger-subtle` |
| `text-[10px]` / `text-[11px]` / `text-xs` | `text-micro` / `text-caption` / `text-caption` |
| `text-sm` / `text-[24px]` | `text-body` / `text-page-title` |
| raw `<button className="… bg-brand …">` | `<Button variant="accent">` (lime fill) |
| raw `<button className="… bg-ink …">` | `<Button variant="brand">` (ink fill, lime text) |
| hand-rolled panel + header + `border-b` | `<SectionCard>` |

---

## Migrated so far

`app.css` (token layer) · `_layout.tsx` · `dashboard.tsx` · `orders.tsx` ·
`orders/customers.tsx` · `orders/customers/$id.tsx` · `stat-card.tsx` ·
`products-panel.tsx` · `orders-table.tsx` · `profit-bar-chart.tsx` · `section-card.tsx` ·
`page-header.tsx` · `empty-state.tsx` · `lib/customer-status.ts` · `lib/address.ts` ·
`customer-activity.tsx` · `customer-gst-dialog.tsx` · `customer-orders-panel.tsx` ·
`orders/invoices.tsx` · `invoices-table.tsx` · `invoice-detail-dialog.tsx` ·
`gstr1-panels.tsx` · `gstr3b-panels.tsx` · `gst-filing-sidebar.tsx` ·
`segmented-tabs.tsx` · `lib/invoice-status.ts` · `lib/gst-return.ts` ·
`conversation.tsx` · `components/app/conversation/*` (21 files) ·
`lib/conversation-format.ts` · `lib/session-window.ts` · `lib/product-drag.ts` ·
`routes/app/logistics/*` (5 screens) · `components/app/logistics/*` (4 files) ·
`lib/logistics-status.ts` · `lib/logistics-format.ts` · `ui/{radio-group,alert}.tsx` ·
`components/app/product-variants/*` (5 files) · `lib/variant-grouping.ts` ·
`lib/variant-draft.ts`

## Remaining debt, ranked

1. `routes/app/settings.tsx` — 1,730 LOC, 86 hex, 126 palette utils, 46 raw buttons
2. `routes/app/orders/$id.tsx`
3. `routes/app/products/$id.tsx` — 2,322 LOC (was 3,397; the Variants tab moved out to
   `components/app/product-variants/` and is on the system. The Overview tab, the sidebar
   and the local `Section` wrapper are the rest of the debt.)
4. `routes/auth/*`, `routes/onboarding/*`

`routes/app/products/inventory*`, `products.tsx` and `admin/*` are already partly on
the system and are the best model to standardise against.

Note `routes/app/products/$id.tsx` now imports two token-clean cards into a route that is
otherwise pre-migration — expect `text-[12px]` next to `text-caption` in the same file
until the Overview tab follows.
