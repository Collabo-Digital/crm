import { useIndianStates } from "~/hooks/use-gst-queries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { OrderAddressInput } from "~/types/api";
import { PhoneInput } from "~/components/app/phone-input";

/**
 * Address capture for offline orders and drafts.
 *
 * Emits Shopify-compatible snake_case keys so offline and synced orders share
 * one shape, plus `stateCode` (the 2-digit GST code) which is what the
 * place-of-supply resolver reads. The state picker sets `stateCode` and
 * `province` together — the former decides CGST+SGST vs IGST, the latter is
 * what packing slips and invoices print.
 */
export function AddressFields({
  value,
  onChange,
}: {
  value: OrderAddressInput;
  onChange: (next: OrderAddressInput) => void;
}) {
  const { data: states } = useIndianStates();

  const patch = (p: Partial<OrderAddressInput>) => onChange({ ...value, ...p });

  return (
    <div className="grid grid-cols-2 gap-2">
      <Field
        label="First name"
        value={value.first_name ?? ""}
        onChange={(v) => patch({ first_name: v || undefined })}
      />
      <Field
        label="Last name"
        value={value.last_name ?? ""}
        onChange={(v) => patch({ last_name: v || undefined })}
      />

      <div className="col-span-2">
        <Field
          label="Address line 1"
          value={value.address1 ?? ""}
          onChange={(v) => patch({ address1: v || undefined })}
        />
      </div>
      <div className="col-span-2">
        <Field
          label="Address line 2 (optional)"
          value={value.address2 ?? ""}
          onChange={(v) => patch({ address2: v || undefined })}
        />
      </div>

      <Field
        label="City"
        value={value.city ?? ""}
        onChange={(v) => patch({ city: v || undefined })}
      />
      <Field
        label="PIN code"
        value={value.zip ?? ""}
        onChange={(v) => patch({ zip: v || undefined })}
      />

      <div className="col-span-2">
        <label className="block">
          <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            State — sets GST place of supply
          </span>
          <Select
            value={value.stateCode ?? ""}
            onValueChange={(code) =>
              patch({
                stateCode: code,
                province: states?.find((s) => s.code === code)?.name,
                country: "India",
                country_code: "IN",
              })
            }
          >
            <SelectTrigger className="mt-1 h-8 text-xs">
              <SelectValue placeholder="Select a state" />
            </SelectTrigger>
            <SelectContent>
              {states?.map((s) => (
                <SelectItem key={s.code} value={s.code} className="text-xs">
                  {s.name} ({s.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="col-span-2">
        <PhoneInput
          label="Phone (optional)"
          value={value.phone}
          onChange={(v) => patch({ phone: v })}
        />
      </div>
    </div>
  );
}

/**
 * True when the user actually typed something. An untouched form must send
 * `undefined` rather than `{}` — an empty object would still count as "an
 * address exists" downstream and blank out the slip.
 */
export function cleanAddress(
  a: OrderAddressInput | undefined,
): OrderAddressInput | undefined {
  if (!a) return undefined;
  const filled = Object.values(a).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
  if (!filled) return undefined;
  // This form only captures Indian addresses (its state list is India's), but
  // the country was set only when a state was picked. An address sent without
  // one took Shopify's STORE country — "United States" on a US store — and
  // came back as a foreign address, taxed as an export (place of supply 96).
  // An address that already names its country (e.g. autofilled from Shopify)
  // keeps it.
  return a.country_code || a.country
    ? a
    : { ...a, country: "India", country_code: "IN" };
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
      />
    </label>
  );
}
