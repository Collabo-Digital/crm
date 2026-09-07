import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Exchange rates for converting an order's own currency into the organisation's
 * reporting currency.
 *
 * Why this exists at all: orders are stored in the currency the channel sold
 * in. For a Shopify store that is the SHOP's currency, and Shopify cannot help
 * us convert it — its money fields only ever span presentment vs shop currency,
 * and the org currency is a Collabo concept the store knows nothing about. So
 * the rate has to come from somewhere else.
 *
 * Why the rate is always asked for BY DATE, never "now": a converted total is
 * an accounting figure. Last July's revenue has to come back the same every
 * time it is asked for, and has to keep agreeing with a GST return already
 * filed on it. Converting at today's rate would move both every day — between
 * 31 Jul and 4 Sep 2026 USD/INR moved 95.39 → 94.49, which is roughly 1% of
 * every dollar order silently rewriting itself.
 *
 * Rates are therefore captured once, at the order's own date, and stored on the
 * order. This service is only consulted when that stored value is missing.
 */
@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);

  /**
   * ECB reference rates via Frankfurter — free, no API key, and serves
   * historical dates, which the backfill needs. Published once per working day
   * around 16:00 CET.
   */
  private readonly endpoint = 'https://api.frankfurter.dev/v1';

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The rate columns to store on an order being written.
   *
   * Every order-creation path calls this, so a new order is booked with its
   * rate already on it. Without that the order lands with a NULL rate and is
   * excluded from every converted total until someone re-runs the backfill —
   * which is how a total silently starts missing today's sales.
   *
   * Returns nulls (never 1) when the rate cannot be established, so a foreign
   * order is left visibly unconverted rather than quietly booked at parity.
   */
  async ratePatch(
    orgId: string,
    orderCurrency: string | null | undefined,
    orderDate: Date | null | undefined,
  ): Promise<{ exchangeRate: number | null; baseCurrency: string | null }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { currency: true },
    });

    const base = (org?.currency ?? '').toUpperCase();
    const quote = (orderCurrency ?? '').toUpperCase();
    if (!base || !quote) return { exchangeRate: null, baseCurrency: null };

    const rate = await this.getRate(quote, base, orderDate ?? new Date());
    return rate == null
      ? { exchangeRate: null, baseCurrency: null }
      : { exchangeRate: rate, baseCurrency: base };
  }

  /**
   * Units of `to` per 1 unit of `from`, as at `onDate`.
   *
   * Returns NULL — never a guess, and never 1 — when the rate cannot be
   * established. A wrong rate is indistinguishable from a right one once it is
   * written to an order, so the only safe failure is to leave it unset and let
   * the caller decide.
   */
  async getRate(from: string, to: string, onDate: Date): Promise<number | null> {
    const base = from?.toUpperCase();
    const quote = to?.toUpperCase();
    if (!base || !quote) return null;

    // Same currency is exactly 1 — not a rate lookup, and must never depend on
    // a third party being reachable.
    if (base === quote) return 1;

    const day = this.isoDay(onDate);
    const key = `fx:${base}:${quote}:${day}`;

    const cached = await this.redis.get<number>(key).catch(() => null);
    if (typeof cached === 'number' && cached > 0) return cached;

    const rate = await this.fetchRate(base, quote, day);
    if (rate == null) return null;

    // A past day's reference rate is immutable, so it can be cached hard.
    // Today's is still provisional until the ECB publishes, so it gets an hour.
    const isToday = day === this.isoDay(new Date());
    await this.redis
      .set(key, rate, isToday ? 3600 : 60 * 60 * 24 * 30)
      .catch(() => undefined);

    return rate;
  }

  private async fetchRate(base: string, quote: string, day: string): Promise<number | null> {
    // Frankfurter serves the most recent working day's rate for a weekend or
    // holiday date, which is the correct treatment: there is no published rate
    // on a day the market did not trade.
    const url = `${this.endpoint}/${day}?base=${base}&symbols=${quote}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal }).finally(() =>
        clearTimeout(timeout),
      );

      if (!response.ok) {
        this.logger.warn(`FX ${base}->${quote} @ ${day}: provider returned ${response.status}`);
        return null;
      }

      const body = (await response.json()) as { rates?: Record<string, number> };
      const rate = body?.rates?.[quote];

      // A non-finite or non-positive rate is corrupt input, not a rate.
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        this.logger.warn(`FX ${base}->${quote} @ ${day}: no usable rate in response`);
        return null;
      }

      return rate;
    } catch (err) {
      // Unreachable provider is not an error the caller should crash on — the
      // order simply keeps a NULL rate and is excluded from converted totals
      // until a later run resolves it.
      this.logger.warn(
        `FX ${base}->${quote} @ ${day}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** UTC calendar day — the rate provider keys on a date, not an instant. */
  private isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
