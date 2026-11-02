import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { AddressFields, cleanAddress } from "~/components/app/order-create/address-fields";
import { PhoneInput, isPhoneValidOrEmpty } from "~/components/app/phone-input";
import { useUpdateCustomerMutation } from "~/hooks/use-customer-mutations";
import { addressProblem } from "~/lib/address";
import type { CustomerDetail, OrderAddressInput } from "~/types/api";

/** The keys the address form edits, which are also the ones the server accepts. */
const ADDRESS_KEYS = [
  "first_name",
  "last_name",
  "company",
  "address1",
  "address2",
  "city",
  "province",
  "stateCode",
  "zip",
  "country",
  "country_code",
  "phone",
] as const satisfies ReadonlyArray<keyof OrderAddressInput>;

/** The saved address in the form's shape. A Shopify address carries more keys; they are left out. */
function formAddress(customer: CustomerDetail): OrderAddressInput {
  const saved = (customer.defaultAddress ?? customer.addresses?.[0] ?? {}) as Record<string, unknown>;
  const out: OrderAddressInput = {};
  for (const key of ADDRESS_KEYS) {
    const value = saved[key];
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

/**
 * Said wherever a Shopify customer is edited: a later change in Shopify comes
 * back through the sync and replaces what was typed here.
 */
function ShopifyNote({ customer }: { customer: CustomerDetail }) {
  if (customer.channel?.platform !== "SHOPIFY") return null;
  return (
    <p className="text-caption text-muted-foreground">
      This customer comes from Shopify. If their details change there, Shopify's version replaces this one.
    </p>
  );
}

export function CustomerPhoneDialog({ customer, onClose }: { customer: CustomerDetail; onClose: () => void }) {
  const [phone, setPhone] = useState<string | undefined>(customer.phone ?? undefined);
  const update = useUpdateCustomerMutation(customer.id);
  const valid = isPhoneValidOrEmpty(phone);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit phone number</DialogTitle>
          <DialogDescription>
            Used for WhatsApp messages and order updates. Clear it to remove the number.
          </DialogDescription>
        </DialogHeader>
        <PhoneInput label="Phone" value={phone} onChange={setPhone} />
        <ShopifyNote customer={customer} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || update.isPending}
            onClick={() => update.mutate({ phone: phone ?? "" }, { onSuccess: onClose })}
          >
            {update.isPending && <Loader2 className="animate-spin" />}
            Save phone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerAddressDialog({ customer, onClose }: { customer: CustomerDetail; onClose: () => void }) {
  const [address, setAddress] = useState<OrderAddressInput>(() => formAddress(customer));
  // The problem shows after the first Save, not while the form is being filled in.
  const [tried, setTried] = useState(false);
  const update = useUpdateCustomerMutation(customer.id);
  const filled = cleanAddress(address);
  const problem = filled ? addressProblem(filled) : "Enter the address.";

  function save() {
    setTried(true);
    if (problem || !filled) return;
    update.mutate({ defaultAddress: filled }, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit shipping address</DialogTitle>
          <DialogDescription>
            The address new orders for this customer fill in. Orders already placed keep theirs.
          </DialogDescription>
        </DialogHeader>
        <AddressFields value={address} onChange={setAddress} />
        {tried && problem && (
          <p role="alert" className="text-caption text-danger-text">
            {problem}
          </p>
        )}
        <ShopifyNote customer={customer} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={update.isPending} onClick={save}>
            {update.isPending && <Loader2 className="animate-spin" />}
            Save address
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
