import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

/**
 * Phone field with a country-code picker. Emits E.164 ("+919847586793").
 *
 * The field used to be free text, so phones were stored as typed — and a
 * counter sale's "9847586793" made Shopify reject the whole pushed order
 * ("Order Phone is invalid"). With the country chosen here, what the CRM
 * stores is the number Shopify accepts.
 *
 * Invalid input is still emitted (so the form can see it and block saving),
 * and the error only shows once the field has been left, so it doesn't nag
 * mid-typing.
 */

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

interface CountryOption {
  code: CountryCode;
  name: string;
  dial: string;
}

// India first — nearly every counter sale is Indian — then alphabetical.
const COUNTRIES: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: COUNTRY_NAMES.of(code) ?? code,
    dial: `+${getCountryCallingCode(code)}`,
  }))
  .sort((a, b) =>
    a.code === "IN" ? -1 : b.code === "IN" ? 1 : a.name.localeCompare(b.name),
  );

function countryName(code: CountryCode): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** True for an empty field or a valid number — the check forms gate on. */
export function isPhoneValidOrEmpty(value: string | undefined | null): boolean {
  return !value || isValidPhoneNumber(value);
}

/** Split an incoming E.164 value into picker country + formatted national part. */
function split(value: string | undefined, fallback: CountryCode) {
  if (!value) return { country: fallback, national: "" };
  const parsed = parsePhoneNumberFromString(value, fallback);
  if (!parsed) return { country: fallback, national: value };
  const country = parsed.country ?? fallback;
  return {
    country,
    national: new AsYouType(country).input(String(parsed.nationalNumber)),
  };
}

/** What to emit for the typed text under the chosen country. */
function compose(text: string, country: CountryCode): string | undefined {
  const digits = text.replace(/[^\d+]/g, "");
  if (!digits.replace(/\+/g, "")) return undefined;
  const parsed = parsePhoneNumberFromString(text, country);
  if (parsed) return parsed.number;
  // Too short or malformed to parse — keep what was typed, prefixed with the
  // dial code, so the form still sees a (failing) value.
  return digits.startsWith("+")
    ? digits
    : `+${getCountryCallingCode(country)}${digits}`;
}

export function PhoneInput({
  label,
  value,
  onChange,
  defaultCountry = "IN",
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  defaultCountry?: CountryCode;
}) {
  const initial = split(value, defaultCountry);
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [national, setNational] = useState(initial.national);
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(false);
  const errorId = useId();
  const [query, setQuery] = useState("");

  // Re-sync only when the value changes from OUTSIDE (form reset, prefill);
  // echoing our own emissions back would fight the cursor while typing.
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const next = split(value, defaultCountry);
    setCountry(next.country);
    setNational(next.national);
  }, [value, defaultCountry]);

  function emit(next: string | undefined) {
    lastEmitted.current = next;
    onChange(next);
  }

  function handleType(text: string) {
    // A pasted "+44 7911…" carries its own country — follow it.
    if (text.trim().startsWith("+")) {
      const typer = new AsYouType();
      const formatted = typer.input(text);
      const detected = typer.getCountry();
      if (detected) {
        setCountry(detected);
        const nationalOnly = String(typer.getNumber()?.nationalNumber ?? "");
        setNational(new AsYouType(detected).input(nationalOnly));
        emit(compose(`+${getCountryCallingCode(detected)}${nationalOnly}`, detected));
        return;
      }
      setNational(formatted);
      emit(compose(text, country));
      return;
    }
    // Kept exactly as typed — reformatting per keystroke makes backspace
    // fight inserted brackets/spaces. Formatted on blur instead.
    setNational(text);
    emit(compose(text, country));
  }

  function handleBlur() {
    setTouched(true);
    const digits = national.replace(/\D/g, "");
    if (digits && !national.trim().startsWith("+")) {
      setNational(new AsYouType(country).input(digits));
    }
  }

  function pickCountry(code: CountryCode) {
    setCountry(code);
    setOpen(false);
    setQuery("");
    const digits = national.replace(/\D/g, "");
    setNational(digits ? new AsYouType(code).input(digits) : "");
    emit(compose(digits, code));
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\+/, "");
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase() === q ||
        c.dial.slice(1).startsWith(q),
    );
  }, [query]);

  const invalid = touched && !isPhoneValidOrEmpty(value);
  const dial = `+${getCountryCallingCode(country)}`;

  return (
    <div className="block">
      <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
      </span>
      <div
        className={cn(
          "mt-1 flex h-8 w-full items-stretch overflow-hidden rounded-lg border bg-white dark:bg-gray-800 focus-within:ring-1",
          invalid
            ? "border-destructive focus-within:ring-destructive/40"
            : "border-input focus-within:border-ring focus-within:ring-ring",
        )}
      >
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <PopoverTrigger
            type="button"
            aria-label={`Country code: ${countryName(country)} ${dial}`}
            title={countryName(country)}
            className="flex shrink-0 items-center gap-1 border-r border-input px-2 text-xs hover:bg-muted/60 focus-visible:outline-none"
          >
            <span className="rounded bg-muted px-1 text-[9px] font-semibold text-muted-foreground">
              {country}
            </span>
            <span className="tabular-nums text-foreground">{dial}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search country or code…"
                  aria-label="Search countries"
                  className="h-8 rounded-lg pl-8 text-xs"
                />
              </div>
            </div>
            <div role="listbox" className="max-h-64 overflow-y-auto p-1">
              {shown.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                  No country matches “{query}”.
                </p>
              ) : (
                shown.map((c) => {
                  const active = c.code === country;
                  return (
                    <button
                      key={c.code}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => pickCountry(c.code)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                        active && "bg-muted",
                      )}
                    >
                      <span className="w-6 shrink-0 text-[9px] font-semibold text-muted-foreground">
                        {c.code}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="tabular-nums text-muted-foreground">{c.dial}</span>
                      {active && <Check className="size-3.5 text-foreground" />}
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={national}
          onChange={(e) => handleType(e.target.value)}
          onBlur={handleBlur}
          className="min-w-0 flex-1 bg-transparent px-2 text-xs focus:outline-none"
        />
      </div>
      {invalid && (
        <p id={errorId} className="mt-1 text-[10px] text-destructive">
          Enter a valid phone number for {countryName(country)}.
        </p>
      )}
    </div>
  );
}
