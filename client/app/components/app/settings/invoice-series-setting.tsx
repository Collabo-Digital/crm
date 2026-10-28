import { AlertTriangle } from "lucide-react";

import { Input } from "~/components/ui/input";

export const DEFAULT_PREFIX = "INV";
const RESERVED_PREFIX = "CN";
/** Mirrors the server rule in tax-settings.schema — letters and digits, max 3. */
const PREFIX_PATTERN = /^[A-Z0-9]{1,3}$/;

/** "2026-27" → "26-27". Matches the server's shortFinancialYear. */
function shortFinancialYear(): string {
  const now = new Date();
  // Indian financial year starts 1 April. Month is 0-indexed, so >= 3 is April.
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${String(startYear % 100).padStart(2, "0")}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Why a typed prefix can't be saved, or null when it can. */
export function invoicePrefixError(candidate: string): string | null {
  if (!PREFIX_PATTERN.test(candidate)) return "Use 1 to 3 letters or digits, with no spaces or punctuation.";
  if (candidate === RESERVED_PREFIX) return `"${RESERVED_PREFIX}" is reserved for credit notes.`;
  return null;
}

/**
 * Invoice series prefix, part of the Tax & GST form (see GstReturnSettings,
 * which saves it).
 *
 * Sits in Tax & GST because an invoice number is statutory output, which is
 * also why the server route is manager-gated. The consequence of a change is
 * spelled out rather than discovered: each prefix is its own consecutive run,
 * so switching starts a fresh one at 000001.
 */
export function InvoiceSeriesSetting({
  value,
  savedPrefix,
  readOnly,
  onChange,
}: {
  value: string;
  savedPrefix: string;
  readOnly: boolean;
  onChange: (prefix: string) => void;
}) {
  const candidate = value.trim().toUpperCase();
  const changed = candidate !== savedPrefix;
  const error = invoicePrefixError(candidate);
  const preview = `${error ? savedPrefix : candidate}-${shortFinancialYear()}/000001`;

  return (
    <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border">
      <div className="border-b pb-4">
        <h3 className="text-body font-semibold text-foreground">Invoice numbering</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">
          The code every invoice number starts with.
        </p>
      </div>

      <div className="mt-4 sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
        <label htmlFor="invoice-prefix" className="text-caption font-medium text-foreground">
          Invoice prefix
          <span className="mt-0.5 block text-caption font-normal text-muted-foreground">
            Up to 3 letters or digits. The year and a running number are added
            automatically, keeping the whole number within the 16 characters GST
            allows. Credit notes always use {RESERVED_PREFIX}.
          </span>
        </label>

        <div className="mt-1 sm:col-span-2 sm:mt-0">
          <div className="flex items-center gap-2">
            <Input
              id="invoice-prefix"
              value={value}
              maxLength={3}
              disabled={readOnly}
              aria-invalid={(changed && !!error) || undefined}
              onChange={(e) => onChange(e.target.value.toUpperCase())}
              className="w-24 font-mono uppercase"
            />
            <span className="font-mono text-caption text-muted-foreground">{preview}</span>
          </div>

          {error && changed && <p className="mt-1.5 text-caption text-danger-text">{error}</p>}

          {/* Shown only while the value differs, so it reads as a consequence of
              this edit rather than a permanent warning. */}
          {changed && !error && (
            <p className="mt-2 flex items-start gap-1.5 text-caption text-muted-foreground">
              <AlertTriangle className="mt-px size-3 shrink-0 text-warning" />
              <span>
                Numbering restarts at 000001 under {candidate}. That is a new
                series, which GST allows as long as each series runs
                consecutively. Invoices already issued keep their numbers.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
