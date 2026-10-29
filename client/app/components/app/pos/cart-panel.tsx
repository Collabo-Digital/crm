import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Award, BadgePercent, ChevronRight, Minus, PencilLine, Plus, ShieldCheck, StickyNote, Trash2, UserRound, X } from "lucide-react";
import { PosScreenHeader } from "~/components/app/pos/pos-screen";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  customerName,
  formatPhone,
  lineDiscount,
  lineGross,
  lineNet,
  oversold,
  type ApprovalNeed,
  type PosCartCustomer,
  type PosCartLine,
  type PosTotals,
} from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosDiscount } from "~/types/api";

const inr = (n: number) => formatCurrency(n, "INR");

/**
 * The right side of the till (a full-height screen on phones): who is buying,
 * the lines, discounts, a note, the totals and the Charge button.
 */
export function CartPanel({
  lines,
  totals,
  flashKey,
  customer,
  customerRequired,
  cartDiscount,
  note,
  gstEnabled,
  priceChangeNeedsPin,
  approvalNeed,
  approvedBy,
  onLine,
  onRemove,
  onClear,
  onCartDiscount,
  onNote,
  onPickCustomer,
  onRemoveCustomer,
  onPay,
  onClose,
  footerExtra,
}: {
  lines: PosCartLine[];
  totals: PosTotals;
  flashKey: { key: string; at: number } | null;
  customer: PosCartCustomer | null;
  customerRequired: boolean;
  cartDiscount: PosDiscount | null;
  note: string;
  gstEnabled: boolean;
  priceChangeNeedsPin: boolean;
  approvalNeed: ApprovalNeed | null;
  approvedBy: string | null;
  onLine: (key: string, patch: Partial<PosCartLine>) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onCartDiscount: (discount: PosDiscount | null) => void;
  onNote: (note: string) => void;
  onPickCustomer: () => void;
  onRemoveCustomer: () => void;
  onPay: () => void;
  /** Shown as a close button in the header, for the phone's cart screen. */
  onClose?: () => void;
  /** The snackbar, on the phone's cart screen, so its Undo stays reachable. */
  footerExtra?: ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showNote, setShowNote] = useState(false);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PosScreenHeader
        left={
          onClose && (
            <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Close the cart" onClick={onClose}>
              <X />
            </Button>
          )
        }
        title={
          <>
            Cart
            {totals.items > 0 && <span className="ml-2 text-caption font-normal text-muted-foreground">{totals.items} item{totals.items === 1 ? "" : "s"}</span>}
          </>
        }
        right={
          lines.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={onClear} className="text-muted-foreground max-md:h-11">
              Clear cart
            </Button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <CustomerRow customer={customer} required={customerRequired} onPick={onPickCustomer} onRemove={onRemoveCustomer} />

        {lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-caption text-muted-foreground">The cart is empty. Tap a product, search, or scan to add one.</p>
        ) : (
          <>
            <ul className="divide-y border-b" aria-label="Items in the cart">
              {lines.map((line) => (
                <CartLineRow
                  key={line.key}
                  line={line}
                  flash={flashKey?.key === line.key ? flashKey.at : 0}
                  editing={editing === line.key}
                  priceChangeNeedsPin={priceChangeNeedsPin}
                  onEdit={() => setEditing(editing === line.key ? null : line.key)}
                  onLine={(patch) => onLine(line.key, patch)}
                  onRemove={() => onRemove(line.key)}
                />
              ))}
            </ul>
            <div className="space-y-3 px-4 py-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={cartDiscount ? "secondary" : "outline"} size="sm" className="max-md:h-11" onClick={() => setShowDiscount(!showDiscount)} aria-expanded={showDiscount}>
                  <BadgePercent />
                  {cartDiscount ? `Cart discount ${cartDiscount.type === "percent" ? `${cartDiscount.value}%` : inr(cartDiscount.value)}` : "Cart discount"}
                </Button>
                <Button type="button" variant={note ? "secondary" : "outline"} size="sm" className="max-md:h-11" onClick={() => setShowNote(!showNote)} aria-expanded={showNote}>
                  <StickyNote />
                  {note ? "Note added" : "Add note"}
                </Button>
              </div>
              {showDiscount && <DiscountEditor label="Discount on the whole cart" value={cartDiscount} onChange={onCartDiscount} />}
              {showNote && (
                <Textarea value={note} maxLength={500} rows={2} onChange={(e) => onNote(e.target.value)} placeholder="Alteration on Saturday, gift wrap…" aria-label="Note on this sale" />
              )}
            </div>
          </>
        )}
      </div>

      {footerExtra}

      <div className="shrink-0 space-y-3 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <dl className="space-y-1 text-body">
          <Row label="Subtotal" value={inr(totals.subtotal)} />
          {totals.lineDiscounts + totals.cartDiscount > 0 && <Row label="Discounts" value={`−${inr(totals.lineDiscounts + totals.cartDiscount)}`} />}
          {gstEnabled && lines.length > 0 && (
            <Row
              label="GST included"
              hint={totals.gstEstimate == null ? undefined : "estimate"}
              value={totals.gstEstimate == null ? <span className="text-caption text-muted-foreground">Worked out on the bill</span> : inr(totals.gstEstimate)}
              muted
            />
          )}
          {totals.roundOff !== 0 && <Row label="Round-off" value={`${totals.roundOff > 0 ? "+" : "−"}${inr(Math.abs(totals.roundOff))}`} muted />}
          <div className="flex items-baseline justify-between border-t pt-2">
            <dt className="text-section">Payable</dt>
            <dd className="text-subhead tabular-nums">{inr(totals.payable)}</dd>
          </div>
        </dl>

        {approvalNeed && !approvedBy && (
          <p className="flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-warning-strong">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{approvalNeed.summary} A manager's PIN is asked for when you charge.</span>
          </p>
        )}
        {approvalNeed && approvedBy && (
          <p className="flex items-center gap-2 text-caption text-success">
            <ShieldCheck className="size-4 shrink-0" />
            Approved by {approvedBy}.
          </p>
        )}

        <Button type="button" variant="accent" className="h-13 w-full rounded-xl text-section md:h-14" disabled={lines.length === 0} onClick={onPay}>
          Charge {inr(totals.payable)}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, hint, muted }: { label: string; value: ReactNode; hint?: string; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", muted && "text-muted-foreground")}>
      <dt>
        {label}
        {hint && <span className="ml-1 text-caption">({hint})</span>}
      </dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** Who is buying, first in the cart; tap to add or change, × to bill a walk-in. */
function CustomerRow({
  customer,
  required,
  onPick,
  onRemove,
}: {
  customer: PosCartCustomer | null;
  required: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  if (!customer) {
    return (
      <button type="button" onClick={onPick} className="flex min-h-16 w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-muted/60">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UserRound className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label">Add customer</span>
          <span className={cn("block text-caption", required ? "text-warning-strong" : "text-muted-foreground")}>
            {required ? "This store needs the customer's mobile on every bill." : "Their mobile number, for the bill on WhatsApp."}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  const name = customerName(customer);
  const phone = formatPhone(customer.phone);
  const existing = customer.existing;
  return (
    <div className="flex items-center gap-1 border-b py-1.5 pr-2 pl-4">
      <button type="button" onClick={onPick} className="flex min-h-13 min-w-0 flex-1 items-center gap-3 py-1.5 text-left" aria-label={`Customer ${name || phone}. Change`}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-label text-brand-foreground">
          {(name || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate text-label">
            {name || phone || "Customer"}
            {existing && existing.vipLevel !== "NONE" && <Award className="size-3.5 shrink-0 text-warning" aria-label={`${existing.vipLevel} customer`} />}
          </span>
          <span className="block truncate text-caption text-muted-foreground">
            {[
              name ? phone : null,
              existing ? `Returning · ${existing.ordersCount} visit${existing.ordersCount === 1 ? "" : "s"} · ${inr(existing.totalSpent)}` : "New customer",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {customer.gstin && <span className="block truncate font-mono text-micro text-muted-foreground">GSTIN {customer.gstin}</span>}
        </span>
      </button>
      <Button type="button" variant="ghost" size="icon-sm" className="max-md:size-11" aria-label="Remove the customer" onClick={onRemove}>
        <X />
      </Button>
    </div>
  );
}

function CartLineRow({
  line,
  flash,
  editing,
  priceChangeNeedsPin,
  onEdit,
  onLine,
  onRemove,
}: {
  line: PosCartLine;
  flash: number;
  editing: boolean;
  priceChangeNeedsPin: boolean;
  onEdit: () => void;
  onLine: (patch: Partial<PosCartLine>) => void;
  onRemove: () => void;
}) {
  const off = lineDiscount(line);
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (flash) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [flash]);
  const changedPrice = line.unitPrice !== line.listPrice;
  const stock = line.product?.stockAtStore;
  return (
    <li ref={rowRef} className="relative px-4 py-3">
      {flash > 0 && <span key={flash} aria-hidden className="pointer-events-none absolute inset-0 bg-brand/40 animate-out fade-out-0 fill-mode-forwards duration-1000" />}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-label">{line.title}</p>
          <p className="truncate text-caption text-muted-foreground">
            {line.variantTitle && `${line.variantTitle} · `}
            {changedPrice && <s className="mr-1">{inr(line.listPrice)}</s>}
            {inr(line.unitPrice)} each
            {!line.product && " · Custom item"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-label tabular-nums">{inr(lineNet(line))}</p>
          {off > 0 && <p className="text-caption tabular-nums text-success">−{inr(off)}</p>}
        </div>
      </div>
      {oversold(line) && (
        <p className={cn("mt-1.5 flex items-center gap-1.5 text-caption", stock != null && stock > 0 ? "text-warning-strong" : "text-danger")}>
          <AlertTriangle className="size-3.5 shrink-0" />
          {stock != null && stock > 0 ? `Only ${stock} in stock at this store.` : "Out of stock at this store."} Selling {line.quantity}.
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <div className="flex items-center rounded-lg border">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="max-md:size-11"
            aria-label={`One less ${line.title}`}
            disabled={line.quantity <= 1}
            onClick={() => onLine({ quantity: line.quantity - 1 })}
          >
            <Minus />
          </Button>
          <span className="min-w-8 text-center text-label tabular-nums" aria-label="Quantity">{line.quantity}</span>
          <Button type="button" variant="ghost" size="icon" className="max-md:size-11" aria-label={`One more ${line.title}`} onClick={() => onLine({ quantity: line.quantity + 1 })}>
            <Plus />
          </Button>
        </div>
        <Button type="button" variant={editing ? "secondary" : "ghost"} size="sm" className="max-md:h-11" onClick={onEdit} aria-expanded={editing}>
          <PencilLine />
          Price and discount
        </Button>
        <Button type="button" variant="ghost" size="icon" className="ml-auto text-muted-foreground max-md:size-11" aria-label={`Remove ${line.title}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {editing && (
        <div className="mt-3 space-y-3 rounded-lg bg-muted/60 p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-caption text-muted-foreground">Quantity</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={line.quantity}
                onChange={(e) => onLine({ quantity: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
                className="h-10 bg-background tabular-nums"
              />
            </label>
            <label className="space-y-1">
              <span className="text-caption text-muted-foreground">Price each (₹)</span>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={line.unitPrice}
                onChange={(e) => onLine({ unitPrice: Math.max(0, Math.round(Number(e.target.value) * 100) / 100 || 0) })}
                className="h-10 bg-background tabular-nums"
              />
            </label>
          </div>
          {line.product && changedPrice && (
            <p className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
              <span>{priceChangeNeedsPin ? "A changed price needs a manager's PIN." : `Catalogue price ${inr(line.listPrice)}.`}</span>
              <Button type="button" variant="link" size="xs" onClick={() => onLine({ unitPrice: line.listPrice })}>
                Reset
              </Button>
            </p>
          )}
          <DiscountEditor label="Discount on this line" value={line.discount} onChange={(discount) => onLine({ discount })} max={lineGross(line)} />
        </div>
      )}
    </li>
  );
}

function DiscountEditor({ label, value, onChange, max }: { label: string; value: PosDiscount | null; onChange: (d: PosDiscount | null) => void; max?: number }) {
  const [type, setType] = useState<PosDiscount["type"]>(value?.type ?? "percent");
  const [text, setText] = useState(value ? String(value.value) : "");
  const commit = (nextType: PosDiscount["type"], nextText: string) => {
    const n = Number(nextText);
    if (!nextText || !Number.isFinite(n) || n <= 0) return onChange(null);
    const capped = nextType === "percent" ? Math.min(n, 100) : max != null ? Math.min(n, max) : n;
    onChange({ type: nextType, value: Math.round(capped * 100) / 100 });
  };
  return (
    <div className="space-y-1">
      <span className="text-caption text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <div className="flex shrink-0 rounded-lg border bg-background p-0.5" role="radiogroup" aria-label="Discount type">
          {(["percent", "amount"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => {
                setType(t);
                commit(t, text);
              }}
              className={cn("min-w-10 rounded-md px-2.5 text-label max-md:min-h-10", type === t ? "bg-foreground text-background" : "text-muted-foreground")}
            >
              {t === "percent" ? "%" : "₹"}
            </button>
          ))}
        </div>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={text}
          placeholder="0"
          aria-label={`${label}, ${type === "percent" ? "percent" : "rupees"}`}
          onChange={(e) => {
            setText(e.target.value);
            commit(type, e.target.value);
          }}
          className="h-10 bg-background tabular-nums"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-10"
            onClick={() => {
              setText("");
              onChange(null);
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
