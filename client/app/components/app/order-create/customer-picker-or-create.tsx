import { useEffect, useMemo, useState } from "react";
import { Search, X, UserPlus, Award } from "lucide-react";
import { useCustomers } from "~/hooks/use-customer-queries";
import { useGstins } from "~/hooks/use-gst-queries";
import { useDebounced } from "~/hooks/use-debounced";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { formatCurrency } from "~/lib/utils";
import { PhoneInput } from "~/components/app/phone-input";
import type {
  Customer,
  OfflineCustomerInput,
  OrganizationGstin,
} from "~/types/api";

type Selection = {
  /** Existing customer ID (set when user picks a search result). */
  customerId?: string;
  /** New customer details (set when user fills the inline form). */
  newCustomer?: OfflineCustomerInput;
};

// (A byte-identical private copy of `useDebounced` used to live here. It now
// imports the shared hook, so there is one debounce implementation to reason
// about rather than two that can drift.)

export function CustomerPickerOrCreate({
  value,
  onChange,
  currency,
}: {
  value: Selection;
  onChange: (s: Selection) => void;
  currency: string;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "new">("search");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );

  const debouncedQuery = useDebounced(query);
  const { data: results, isLoading } = useCustomers(
    debouncedQuery ? { search: debouncedQuery, limit: 5 } : undefined,
  );
  const matches = debouncedQuery ? results?.data ?? [] : [];

  function selectExisting(c: Customer) {
    setSelectedCustomer(c);
    setMode("search");
    onChange({ customerId: c.id });
  }

  function clear() {
    setSelectedCustomer(null);
    setQuery("");
    onChange({});
  }

  // ── Selected customer card ──
  if (selectedCustomer) {
    return (
      <div className="rounded-lg border bg-white dark:bg-gray-900 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
              {selectedCustomer.firstName} {selectedCustomer.lastName}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {selectedCustomer.email}
              {selectedCustomer.phone ? ` • ${selectedCustomer.phone}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
              <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-gray-700 dark:text-gray-300">
                {selectedCustomer.ordersCount} prior order
                {selectedCustomer.ordersCount === 1 ? "" : "s"}
              </span>
              <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 tabular-nums text-gray-700 dark:text-gray-300">
                Lifetime: {formatCurrency(selectedCustomer.totalSpent, currency)}
              </span>
              {selectedCustomer.vipLevel !== "NONE" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                  <Award className="size-3" />
                  {selectedCustomer.vipLevel}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  // ── New customer inline form ──
  if (mode === "new") {
    return (
      <NewCustomerForm
        value={value.newCustomer ?? {}}
        onChange={(nc) => onChange({ newCustomer: nc })}
        onCancel={() => {
          setMode("search");
          onChange({});
        }}
      />
    );
  }

  // ── Search mode ──
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search customer by name, email or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-900 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
      </div>

      {debouncedQuery && (
        <div className="rounded-lg border bg-white dark:bg-gray-900 max-h-72 overflow-y-auto">
          {isLoading ? (
            <p className="p-3 text-xs text-muted-foreground">Searching…</p>
          ) : matches.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              No customers match "{debouncedQuery}".
            </div>
          ) : (
            matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectExisting(c)}
                className="block w-full border-b last:border-b-0 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60"
              >
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                  {c.firstName} {c.lastName}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {c.email || c.phone || "—"} • {c.ordersCount} order
                  {c.ordersCount === 1 ? "" : "s"} •{" "}
                  {formatCurrency(c.totalSpent, currency)}
                </p>
              </button>
            ))
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setMode("new")}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
      >
        <UserPlus className="size-3.5" />
        New customer
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

function NewCustomerForm({
  value,
  onChange,
  onCancel,
}: {
  value: OfflineCustomerInput;
  onChange: (next: OfflineCustomerInput) => void;
  onCancel: () => void;
}) {
  const { data: gstins = [] } = useGstins();

  // Show only the states the org has registered GSTINs for. De-dup by code so
  // multiple GSTINs in the same state don't appear twice. Sorted by code.
  const states = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();
    for (const g of gstins as OrganizationGstin[]) {
      if (!g.isActive) continue;
      if (!map.has(g.stateCode)) {
        map.set(g.stateCode, { code: g.stateCode, name: g.stateName });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }, [gstins]);

  function patch(patchObj: Partial<OfflineCustomerInput>) {
    onChange({ ...value, ...patchObj });
  }

  return (
    <div className="rounded-lg border bg-white dark:bg-gray-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
          New customer
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100"
        >
          Search instead
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label="First name"
          value={value.firstName ?? ""}
          onChange={(v) => patch({ firstName: v || undefined })}
        />
        <Field
          label="Last name"
          value={value.lastName ?? ""}
          onChange={(v) => patch({ lastName: v || undefined })}
        />
        <PhoneInput
          label="Phone"
          value={value.phone}
          onChange={(v) => patch({ phone: v })}
        />
        <Field
          label="Email"
          type="email"
          value={value.email ?? ""}
          onChange={(v) => patch({ email: v || undefined })}
        />
        <Field
          label="GSTIN (optional)"
          value={value.gstin ?? ""}
          onChange={(v) => patch({ gstin: v ? v.toUpperCase() : undefined })}
          mono
        />
        <label className="block">
          <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Billing state (optional)
          </span>
          <Select
            value={value.billingStateCode ?? ""}
            onValueChange={(v) =>
              patch({ billingStateCode: v || undefined })
            }
            disabled={states.length === 0}
          >
            <SelectTrigger className="mt-1 h-8 text-xs">
              <SelectValue
                placeholder={
                  states.length === 0
                    ? "Add a GSTIN in Settings first"
                    : "Select a state"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {states.map((s) => (
                <SelectItem key={s.code} value={s.code} className="text-xs">
                  {s.code} — {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Provide at least a name (or phone / email) so this customer can be
        matched on a future visit. State list is pulled from your registered
        GSTINs.
      </p>
    </div>
  );
}
