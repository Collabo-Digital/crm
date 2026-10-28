import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useUpdateTaxSettingsMutation } from "~/hooks/use-settings-mutations";

const DEFAULT_PREFIX = "INV";
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

/**
 * Invoice series prefix.
 *
 * Sits in Tax & GST because an invoice number is statutory output, which is
 * also why the server route is manager-gated. The consequence of a change is
 * spelled out rather than discovered: each prefix is its own consecutive run,
 * so switching starts a fresh one at 000001.
 */
export function InvoiceSeriesSetting() {
  const { data: settings, isLoading } = useOrganizationSettings();
  const mutation = useUpdateTaxSettingsMutation();

  const serverPrefix = settings?.taxSettings?.invoicePrefix ?? DEFAULT_PREFIX;
  const [draft, setDraft] = useState(serverPrefix);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => setDraft(serverPrefix), [serverPrefix]);

  const candidate = draft.trim().toUpperCase();
  const changed = candidate !== serverPrefix;
  const error = !PREFIX_PATTERN.test(candidate)
    ? "Use 1 to 3 letters or digits, with no spaces or punctuation."
    : candidate === RESERVED_PREFIX
      ? `"${RESERVED_PREFIX}" is reserved for credit notes.`
      : null;

  function commit() {
    if (!changed || error) {
      if (error) setDraft(serverPrefix);
      return;
    }
    mutation.mutate(
      { invoicePrefix: candidate },
      {
        onSuccess: () => {
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 1500);
        },
      },
    );
  }

  if (isLoading) return null;

  const preview = `${PREFIX_PATTERN.test(candidate) ? candidate : serverPrefix}-${shortFinancialYear()}/000001`;

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-border dark:bg-gray-900">
      <div className="border-b pb-4">
        <h3 className="text-body font-semibold text-foreground">Invoice numbering</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">
          The code every invoice number starts with.
        </p>
      </div>

      <div className="mt-4 sm:grid sm:grid-cols-3 sm:items-start sm:gap-4">
        <label htmlFor="invoice-prefix" className="text-caption font-medium text-foreground">
          Invoice prefix
          <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
            Up to 3 letters or digits. The year and a running number are added
            automatically, keeping the whole number within the 16 characters GST
            allows. Credit notes always use {RESERVED_PREFIX}.
          </span>
        </label>

        <div className="mt-1 sm:col-span-2 sm:mt-0">
          <div className="flex items-center gap-2">
            <input
              id="invoice-prefix"
              value={draft}
              maxLength={3}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setDraft(serverPrefix);
                  e.currentTarget.blur();
                }
              }}
              className="h-9 w-24 rounded-lg border border-input bg-transparent px-3 font-mono text-caption uppercase focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <span className="font-mono text-caption text-muted-foreground">{preview}</span>
            {mutation.isPending && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            {justSaved && <Check className="size-3.5 text-success" />}
          </div>

          {error && changed && <p className="mt-1.5 text-[10px] text-danger">{error}</p>}

          {/* Shown only while the value differs, so it reads as a consequence of
              this edit rather than a permanent warning. */}
          {changed && !error && (
            <p className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
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
