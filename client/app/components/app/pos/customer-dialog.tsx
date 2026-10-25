import { useState } from "react";
import { Award, Loader2, MessageCircle, Search, UserPlus } from "lucide-react";
import { PhoneInput, isPhoneValidOrEmpty } from "~/components/app/phone-input";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useDebounced } from "~/hooks/use-debounced";
import { usePosCustomers } from "~/hooks/use-pos-queries";
import { formatPhone, GST_STATES, GSTIN_PATTERN, type PosCartCustomer } from "~/lib/pos-cart";
import { formatCurrency } from "~/lib/utils";

const selectClass = "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm";

/** Find a customer by mobile or name, or add a new one, for the sale in the cart. */
export function CustomerDialog({
  open,
  onOpenChange,
  onPick,
  canWalkIn,
  onWalkIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (customer: PosCartCustomer) => void;
  canWalkIn: boolean;
  onWalkIn: () => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "new">("search");
  const debounced = useDebounced(query, 300);
  const { data: results = [], isFetching, isError } = usePosCustomers(debounced);
  const term = debounced.trim();

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setQuery("");
      setMode("search");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "new" ? "New customer" : "Customer"}</DialogTitle>
          <DialogDescription>
            {mode === "new" ? "Their mobile number finds them on the next visit." : "Search by mobile number or name."}
          </DialogDescription>
        </DialogHeader>

        {mode === "new" ? (
          <NewCustomerForm
            seed={query.trim()}
            onBack={() => setMode("search")}
            onDone={(customer) => {
              onPick(customer);
              close(false);
            }}
          />
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                type="search"
                inputMode="search"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="98470 12345 or Anjali"
                aria-label="Search customers by mobile number or name"
                className="h-11 pl-9"
              />
              {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
            </div>

            {term.length > 0 && term.length < 3 ? (
              <p className="text-caption text-muted-foreground">Type at least 3 characters.</p>
            ) : isError ? (
              <p className="text-caption text-danger">Customers could not be searched. Check the connection and try again.</p>
            ) : term.length >= 3 && results.length === 0 && !isFetching ? (
              <p className="text-caption text-muted-foreground">No customer matches “{term}”.</p>
            ) : (
              results.length > 0 && (
                <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {results.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick({ kind: "existing", customer: c, whatsappOptIn: c.whatsappOptIn });
                          close(false);
                        }}
                        className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-body font-medium">
                            {c.name}
                            {c.vipLevel !== "NONE" && <Award className="size-3.5 shrink-0 text-warning" aria-label={`${c.vipLevel} customer`} />}
                            {c.whatsappOptIn && <MessageCircle className="size-3.5 shrink-0 text-success" aria-label="Gets WhatsApp updates" />}
                          </p>
                          <p className="truncate text-caption text-muted-foreground">
                            {[formatPhone(c.phone), `${c.ordersCount} order${c.ordersCount === 1 ? "" : "s"}`, formatCurrency(c.totalSpent, "INR")].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        )}

        {mode === "search" && (
          <DialogFooter>
            {canWalkIn && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onWalkIn();
                  close(false);
                }}
              >
                Walk-in customer
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setMode("new")}>
              <UserPlus />
              New customer
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCustomerForm({ seed, onBack, onDone }: { seed: string; onBack: () => void; onDone: (customer: PosCartCustomer) => void }) {
  // What was typed in the search carries over: digits as the mobile, words as the name.
  const seedIsPhone = /^\+?[\d\s-]{3,}$/.test(seed);
  const [phone, setPhone] = useState<string | undefined>(seedIsPhone ? seed.replace(/[\s-]/g, "") : undefined);
  const [name, setName] = useState(seedIsPhone ? "" : seed);
  const [gstin, setGstin] = useState("");
  const [stateCode, setStateCode] = useState("");
  // WhatsApp's opt-in rules need the customer's own yes, so this starts unticked.
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);

  const gstinValid = !gstin || GSTIN_PATTERN.test(gstin);
  const valid = !!phone && isPhoneValidOrEmpty(phone) && name.trim().length > 0 && gstinValid;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !phone) return;
        onDone({
          kind: "new",
          phone,
          name: name.trim(),
          gstin: gstin || undefined,
          billingStateCode: stateCode || undefined,
          whatsappOptIn,
        });
      }}
    >
      {/* The shared field is sized for the order form; here it matches the 44px fields around it. */}
      <div className="[&>div>div]:h-11 [&>div>div]:text-sm [&>div>span]:text-label [&>div>span]:text-foreground">
        <PhoneInput label="Mobile number" value={phone} onChange={setPhone} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pos-new-name">Name</Label>
        <Input id="pos-new-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoComplete="off" className="h-11" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pos-new-gstin">GSTIN (optional)</Label>
          <Input
            id="pos-new-gstin"
            value={gstin}
            maxLength={15}
            aria-invalid={!gstinValid || undefined}
            onChange={(e) => {
              const next = e.target.value.toUpperCase().replace(/\s/g, "");
              setGstin(next);
              // A GSTIN starts with its state's code.
              const code = next.slice(0, 2);
              if (GST_STATES.some((s) => s.code === code)) setStateCode(code);
            }}
            className="h-11 font-mono uppercase"
          />
          {!gstinValid && <p className="text-caption text-danger">A GSTIN has 15 characters, like 32ABCDE1234F1Z5.</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pos-new-state">State (optional)</Label>
          <select id="pos-new-state" className={selectClass} value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
            <option value="">Not given</option>
            {GST_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2">
        <Checkbox checked={whatsappOptIn} onCheckedChange={(v) => setWhatsappOptIn(v === true)} />
        <span className="text-label">
          WhatsApp updates
          <span className="block text-caption font-normal text-muted-foreground">They agreed to get bills and order updates on WhatsApp.</span>
        </span>
      </label>
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back to search
        </Button>
        <Button type="submit" variant="accent" disabled={!valid}>
          Add customer
        </Button>
      </div>
    </form>
  );
}
