import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Award, ChevronDown, Info, Loader2, X } from "lucide-react";
import { PosScreen, PosScreenBody, PosScreenFooter, PosScreenHeader } from "~/components/app/pos/pos-screen";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { usePosCustomers } from "~/hooks/use-pos-queries";
import { GST_STATES, GSTIN_PATTERN, INDIAN_MOBILE, nationalDigits, PIN_CODE, type PosCartCustomer } from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosSettings } from "~/types/api";

const selectClass = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base md:text-sm aria-invalid:border-destructive";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StepProps {
  /** At Charge it leads on to payment and can be skipped; from the cart it only saves. */
  purpose: "checkout" | "cart";
  initial: PosCartCustomer | null;
  mode: PosSettings["customerAtCheckout"];
  /** The payable now, checked against `requiredAbove`. */
  payable: number;
  requiredAbove: number | null;
  autoSendBill: boolean;
  onDone: (customer: PosCartCustomer) => void;
  onSkip: () => void;
}

/**
 * Who is buying, keyed on the mobile number: the keypad is up, and the tenth
 * digit looks the number up. A match is used as is; anyone new needs no more
 * than the number. GST buyers add a GSTIN, and from `requiredAbove` the bill
 * needs a name and address.
 */
export function CustomerStep({ open, onOpenChange, ...props }: StepProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const phoneRef = useRef<HTMLInputElement>(null);
  return (
    <PosScreen
      open={open}
      onOpenChange={onOpenChange}
      title="Customer"
      description="The customer's mobile number, for the bill."
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        phoneRef.current?.focus();
      }}
    >
      {open && <CustomerForm {...props} phoneRef={phoneRef} onClose={() => onOpenChange(false)} />}
    </PosScreen>
  );
}

function CustomerForm({
  purpose,
  initial,
  mode,
  payable,
  requiredAbove,
  autoSendBill,
  onDone,
  onSkip,
  phoneRef,
  onClose,
}: StepProps & { phoneRef: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const id = useId();
  const [digits, setDigits] = useState(() => nationalDigits(initial?.phone));
  const [name, setName] = useState(initial && !initial.existing ? initial.name : "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [moreOpen, setMoreOpen] = useState(!!initial?.email);
  const [gst, setGst] = useState(!!initial?.gstin);
  const [gstin, setGstin] = useState(initial?.gstin ?? "");
  const [stateCode, setStateCode] = useState(initial?.stateCode ?? "");
  const [address1, setAddress1] = useState(initial?.address?.address1 ?? "");
  const [city, setCity] = useState(initial?.address?.city ?? "");
  const [zip, setZip] = useState(initial?.address?.zip ?? "");
  const [offers, setOffers] = useState(initial?.offersOptIn ?? false);
  const [attempted, setAttempted] = useState(false);

  const complete = INDIAN_MOBILE.test(digits);
  const lookup = usePosCustomers(complete ? digits : "");
  const match = complete ? (lookup.data?.find((c) => nationalDigits(c.phone) === digits) ?? null) : null;
  const looking = complete && !match && (lookup.isFetching || lookup.isPlaceholderData);

  // A saved B2B customer starts with their GSTIN, once per match.
  const seededFor = useRef<string | null>(initial?.existing?.id ?? null);
  useEffect(() => {
    if (!match || seededFor.current === match.id) return;
    seededFor.current = match.id;
    if (match.gstin && !gstin) {
      setGst(true);
      setGstin(match.gstin);
      if (GST_STATES.some((s) => s.code === match.gstin!.slice(0, 2))) setStateCode(match.gstin.slice(0, 2));
    }
  }, [match, gstin]);

  const phoneRequired = mode === "required";
  const needsAddress = requiredAbove != null && payable >= requiredAbove;
  const showAddress = needsAddress || !!initial?.address;
  const canSkip = purpose === "checkout" && !phoneRequired && !needsAddress;
  const finalName = match ? match.name : name.trim();

  const phoneError =
    digits.length > 0 && !complete
      ? digits.length < 10
        ? "Enter all 10 digits of the mobile number."
        : "An Indian mobile number starts with 6, 7, 8 or 9."
      : phoneRequired && !digits
        ? "Enter the customer's mobile number."
        : null;
  const errors = {
    phone: phoneError,
    nothing: !complete && !finalName && !needsAddress ? (purpose === "checkout" ? "Enter a mobile number, or skip for a walk-in." : "Enter a mobile number.") : null,
    name: needsAddress && !finalName ? "Enter the buyer's name." : null,
    email: email.trim() && !EMAIL.test(email.trim()) ? "Check the email address." : null,
    gstin: gst && !GSTIN_PATTERN.test(gstin) ? "A GSTIN has 15 characters, like 32ABCDE1234F1Z5." : null,
    state: (gst || showAddress) && !stateCode ? "Choose the state." : null,
    address1: showAddress && !address1.trim() ? "Enter the address." : null,
    city: showAddress && !city.trim() ? "Enter the city." : null,
    zip: showAddress && !PIN_CODE.test(zip) ? "A PIN code has 6 digits." : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  // A wrong first digit shows at once; anything else waits for Continue.
  const showPhoneError = attempted || (digits.length === 10 && !complete);

  const submit = () => {
    setAttempted(true);
    if (!valid || looking) return;
    onDone({
      existing: match,
      phone: complete ? `+91${digits}` : null,
      name: finalName,
      email: match ? "" : email.trim(),
      gstin: gst ? gstin : "",
      stateCode: gst || showAddress ? stateCode : "",
      address: showAddress ? { address1: address1.trim(), city: city.trim(), zip, stateCode } : null,
      offersOptIn: offers,
    });
  };

  const primary =
    purpose === "cart" && initial ? "Save" : match ? "Use this customer" : purpose === "checkout" ? "Continue" : "Add customer";
  const threshold = requiredAbove != null ? formatCurrency(requiredAbove, "INR", { maximumFractionDigits: 0 }) : "";

  const stateSelect = (
    <Field id={`${id}-state`} label="State" error={attempted ? errors.state : null}>
      <select
        id={`${id}-state`}
        className={selectClass}
        value={stateCode}
        aria-invalid={(attempted && !!errors.state) || undefined}
        aria-describedby={attempted && errors.state ? `${id}-state-error` : undefined}
        onChange={(e) => setStateCode(e.target.value)}
      >
        <option value="">Choose a state</option>
        {GST_STATES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <PosScreenHeader
        left={
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={purpose === "checkout" ? "Back to the cart" : "Close"} onClick={onClose}>
            {purpose === "checkout" ? <ArrowLeft /> : <X />}
          </Button>
        }
        title="Customer"
        right={
          canSkip && (
            <Button type="button" variant="ghost" className="h-11 px-3 text-label" onClick={onSkip}>
              Skip – walk-in
            </Button>
          )
        }
      />
      <PosScreenBody className="space-y-5">
        {needsAddress && (
          <p className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-caption text-info">
            <Info className="mt-0.5 size-4 shrink-0" />
            GST rules need the buyer's name and address on bills of {threshold} or more.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-phone`}>Mobile number{!phoneRequired && <Optional />}</Label>
          <div
            className={cn(
              "flex h-12 items-stretch overflow-hidden rounded-xl border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
              showPhoneError && phoneError && "border-destructive",
            )}
          >
            <span className="flex items-center border-r bg-muted px-3 text-body font-medium text-muted-foreground">+91</span>
            <input
              ref={phoneRef}
              id={`${id}-phone`}
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              enterKeyHint="next"
              maxLength={14}
              value={digits}
              placeholder="98470 12345"
              aria-invalid={(showPhoneError && !!phoneError) || undefined}
              aria-describedby={`${id}-phone-note`}
              onChange={(e) => {
                let d = e.target.value.replace(/\D/g, "");
                // Pasted with the country code or a trunk 0.
                if (d.length > 10) d = d.replace(/^(91|0)/, "");
                setDigits(d.slice(0, 10));
              }}
              className="min-w-0 flex-1 bg-transparent px-3 text-lg tracking-wide tabular-nums outline-none placeholder:text-muted-foreground/60"
            />
            {looking && <Loader2 className="mr-3 size-4 self-center animate-spin text-muted-foreground" aria-label="Looking up the number" />}
          </div>
          <p id={`${id}-phone-note`} className={cn("text-caption", showPhoneError && phoneError ? "text-danger" : "text-muted-foreground")}>
            {showPhoneError && phoneError
              ? phoneError
              : phoneRequired && !digits
                ? "Customer mobile is required for this store. Ask the customer, or ask a manager to change the setting."
                : autoSendBill
                  ? "We'll send the bill to this number on WhatsApp."
                  : "The bill can be sent to this number on WhatsApp."}
          </p>
          {attempted && !phoneError && errors.nothing && <p className="text-caption text-danger">{errors.nothing}</p>}
          {complete && lookup.isError && <p className="text-caption text-muted-foreground">This number couldn't be looked up. You can still add the customer.</p>}
        </div>

        {match ? (
          <div className="space-y-2">
            <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-label text-brand-foreground">
                {match.name.charAt(0).toUpperCase() || "?"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-label">
                  {match.name}
                  {match.vipLevel !== "NONE" && <Award className="size-3.5 shrink-0 text-warning" aria-label={`${match.vipLevel} customer`} />}
                </p>
                <p className="text-caption text-muted-foreground">
                  Returning · {match.ordersCount} visit{match.ordersCount === 1 ? "" : "s"} · {formatCurrency(match.totalSpent, "INR")} spent
                </p>
                {match.email && <p className="truncate text-caption text-muted-foreground">{match.email}</p>}
              </div>
            </div>
            <button
              type="button"
              className="min-h-11 text-caption font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                setDigits("");
                phoneRef.current?.focus();
              }}
            >
              Not them? Use a different number
            </button>
          </div>
        ) : (
          !looking && (
            <div className="space-y-4">
              <Field id={`${id}-name`} label={gst ? "Business or buyer name" : "Name"} optional={!needsAddress} error={attempted ? errors.name : null}>
                <Input id={`${id}-name`} value={name} maxLength={120} autoComplete="off" autoCapitalize="words" onChange={(e) => setName(e.target.value)} className="h-11" aria-invalid={(attempted && !!errors.name) || undefined} aria-describedby={attempted && errors.name ? `${id}-name-error` : undefined} />
              </Field>
              <div>
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(!moreOpen)}
                  className="flex min-h-11 items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
                >
                  More details
                  <ChevronDown className={cn("size-4 transition-transform", moreOpen && "rotate-180")} />
                </button>
                {moreOpen && (
                  <Field id={`${id}-email`} label="Email" optional error={errors.email && (attempted || !EMAIL.test(email.trim())) ? errors.email : null}>
                    <Input id={`${id}-email`} type="email" inputMode="email" autoComplete="off" value={email} maxLength={160} onChange={(e) => setEmail(e.target.value)} className="h-11" aria-invalid={(attempted && !!errors.email) || undefined} aria-describedby={errors.email && (attempted || !EMAIL.test(email.trim())) ? `${id}-email-error` : undefined} />
                  </Field>
                )}
              </div>
            </div>
          )
        )}

        <div className="space-y-4 border-t pt-4">
          <label htmlFor={`${id}-gst`} className="flex min-h-11 items-center justify-between gap-4">
            <span>
              <span className="block text-label">Need a GST invoice?</span>
              <span className="block text-caption text-muted-foreground">For a business buyer with a GSTIN.</span>
            </span>
            <Switch id={`${id}-gst`} checked={gst} onCheckedChange={setGst} />
          </label>
          {gst && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-gstin`} label="GSTIN" error={attempted || gstin.length === 15 ? errors.gstin : null}>
                <Input
                  id={`${id}-gstin`}
                  value={gstin}
                  maxLength={15}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="32ABCDE1234F1Z5"
                  aria-invalid={((attempted || gstin.length === 15) && !!errors.gstin) || undefined}
                  aria-describedby={(attempted || gstin.length === 15) && errors.gstin ? `${id}-gstin-error` : undefined}
                  onChange={(e) => {
                    const next = e.target.value.toUpperCase().replace(/\s/g, "");
                    setGstin(next);
                    // A GSTIN starts with its state's code.
                    const code = next.slice(0, 2);
                    if (GST_STATES.some((s) => s.code === code)) setStateCode(code);
                  }}
                  className="h-11 font-mono uppercase"
                />
              </Field>
              {!showAddress && stateSelect}
            </div>
          )}
        </div>

        {showAddress && (
          <fieldset className="space-y-4 border-t pt-4">
            <legend className="sr-only">Address</legend>
            <Field id={`${id}-address`} label="Address" error={attempted ? errors.address1 : null}>
              <Input id={`${id}-address`} value={address1} maxLength={200} autoComplete="street-address" placeholder="House, street, area" onChange={(e) => setAddress1(e.target.value)} className="h-11" aria-invalid={(attempted && !!errors.address1) || undefined} aria-describedby={attempted && errors.address1 ? `${id}-address-error` : undefined} />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
              <Field id={`${id}-city`} label="City" error={attempted ? errors.city : null}>
                <Input id={`${id}-city`} value={city} maxLength={80} autoComplete="address-level2" onChange={(e) => setCity(e.target.value)} className="h-11" aria-invalid={(attempted && !!errors.city) || undefined} aria-describedby={attempted && errors.city ? `${id}-city-error` : undefined} />
              </Field>
              <Field id={`${id}-zip`} label="PIN code" error={attempted ? errors.zip : null}>
                <Input
                  id={`${id}-zip`}
                  value={zip}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={6}
                  onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="h-11 tabular-nums"
                  aria-invalid={(attempted && !!errors.zip) || undefined}
                  aria-describedby={attempted && errors.zip ? `${id}-zip-error` : undefined}
                />
              </Field>
            </div>
            {stateSelect}
          </fieldset>
        )}

        <label className="flex min-h-11 items-start gap-3 border-t pt-4">
          <Checkbox checked={offers} onCheckedChange={(v) => setOffers(v === true)} className="mt-0.5 size-5" />
          <span>
            <span className="block text-label">Send me offers on WhatsApp</span>
            <span className="block text-caption text-muted-foreground">Tick only if the customer says yes.</span>
          </span>
        </label>
      </PosScreenBody>
      <PosScreenFooter>
        <Button type="submit" variant="accent" className="h-12 w-full rounded-xl text-section" disabled={looking}>
          {looking && <Loader2 className="animate-spin" />}
          {looking ? "Looking up the number…" : primary}
        </Button>
      </PosScreenFooter>
    </form>
  );
}

function Optional() {
  return <span className="font-normal text-muted-foreground">(optional)</span>;
}

function Field({ id, label, optional, error, children }: { id: string; label: string; optional?: boolean; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {optional && <Optional />}
      </Label>
      {children}
      {error && <p id={`${id}-error`} className="text-caption text-danger">{error}</p>}
    </div>
  );
}
