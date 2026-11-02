import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useUpdateCustomerMutation } from "~/hooks/use-customer-mutations";
import { useIndianStates } from "~/hooks/use-gst-queries";

/** The subset of a customer this dialog reads — satisfied by both `Customer` and `CustomerDetail`. */
interface GstCustomer {
  firstName: string | null;
  lastName: string | null;
  email: string;
  gstin: string | null;
  billingStateCode: string | null;
}

/**
 * GSTIN + place-of-supply editor.
 *
 * Lived inside `routes/app/orders/customers.tsx` until the customer detail page
 * took over row clicks; it is now mounted from that page's actions menu.
 */
export function CustomerGstDialog({
  customerId,
  customer,
  onClose,
}: {
  customerId: string;
  customer: GstCustomer | null;
  onClose: () => void;
}) {
  const [gstin, setGstin] = useState(customer?.gstin ?? "");
  const [billingStateCode, setBillingStateCode] = useState(
    customer?.billingStateCode ?? "",
  );
  const { data: states = [] } = useIndianStates();
  const updateCustomer = useUpdateCustomerMutation(customerId);

  const name = [customer?.firstName, customer?.lastName]
    .filter(Boolean)
    .join(" ");

  function handleSave() {
    const selectedState = states.find((s) => s.code === billingStateCode);
    updateCustomer.mutate(
      {
        gstin: gstin || undefined,
        billingStateCode: billingStateCode || undefined,
        billingStateName: selectedState?.name || undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Customer GST details</DialogTitle>
          <DialogDescription>
            {name || customer?.email || "This customer"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="customer-gstin"
              className="text-label text-foreground"
            >
              Customer GSTIN
            </label>
            <input
              id="customer-gstin"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="29AABCT1332L1ZN"
              maxLength={15}
              className="mt-1 h-8 w-full rounded-lg border border-input bg-transparent px-3 font-mono text-caption placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <p className="mt-1 text-caption text-muted-foreground">
              Leave empty for B2C (unregistered) customers. Required for B2B GST
              invoices.
            </p>
          </div>

          <div>
            <label className="text-label text-foreground">Billing state</label>
            <Select
              value={billingStateCode}
              onValueChange={setBillingStateCode}
            >
              <SelectTrigger className="mt-1 h-8 w-full text-caption">
                <SelectValue placeholder="Select billing state" />
              </SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem
                    key={s.code}
                    value={s.code}
                    className="text-caption"
                  >
                    {s.code} - {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-caption text-muted-foreground">
              Determines Place of Supply for GST invoices.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={handleSave}
            disabled={updateCustomer.isPending}
          >
            {updateCustomer.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
