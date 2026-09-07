import { formatCurrency } from "~/lib/utils";
import type { CurrencyAmount } from "~/types/api";

/**
 * A money total, shown in the organisation's own currency.
 *
 * Orders are stored in the currency the channel sold in, so an INR workspace
 * whose Shopify store sells in USD had its revenue added together at 1:1 and
 * labelled with a rupee sign — "₹12,235.20" for ₹1,911.50 + $10,323.70. The
 * server now converts each order at the rate stored on it (captured at the
 * order's own date), so `amount` here is a single, real figure.
 *
 * `breakdown` is what that figure was made of before conversion. It renders
 * only when the window actually spans more than one currency — an INR-only
 * organisation sees exactly one number and no extra chrome, which is the
 * common case and must stay uncluttered.
 */
export function MoneyTotal({
  amount,
  currency,
  breakdown,
  unconverted = 0,
}: {
  /** Already converted into `currency` by the server. */
  amount: number;
  /** The organisation's reporting currency. */
  currency: string;
  /** Pre-conversion make-up. Shown only when it spans >1 currency. */
  breakdown?: CurrencyAmount[];
  /**
   * Orders left out of `amount` because their rate never resolved. Surfaced
   * rather than hidden — a total quietly missing orders is worse than one that
   * admits it.
   */
  unconverted?: number;
}) {
  const foreign = (breakdown ?? []).filter(
    (part) => part.amount !== 0 && part.currency !== currency,
  );

  return (
    <span className="flex flex-col leading-tight">
      <span className="tabular-nums">{formatCurrency(amount, currency)}</span>

      {foreign.length > 0 && (
        <span className="text-caption font-normal text-muted-foreground">
          incl.{" "}
          {foreign
            .map((part) => formatCurrency(part.amount, part.currency))
            .join(" + ")}{" "}
          converted
        </span>
      )}

      {unconverted > 0 && (
        <span className="text-caption font-normal text-warning">
          {unconverted} order{unconverted === 1 ? "" : "s"} excluded — no
          exchange rate yet
        </span>
      )}
    </span>
  );
}
