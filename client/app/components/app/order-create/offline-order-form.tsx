import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCreateOfflineOrderMutation } from "~/hooks/use-order-mutations";
import { useCreateDraftOrderMutation } from "~/hooks/use-draft-order-mutations";
import { CustomerPickerOrCreate } from "./customer-picker-or-create";
import { ProductPicker, type CartLineSeed } from "./product-picker";
import { OrderCart, type CartLine } from "./order-cart";
import { BillSummary, billTotals } from "./bill-summary";
import { Button } from "~/components/ui/button";
import { formatCurrency } from "~/lib/utils";
import { AddressFields, cleanAddress } from "./address-fields";
import { isPhoneValidOrEmpty } from "~/components/app/phone-input";
import { useSelectedLocation } from "~/hooks/use-selected-location";
import { useCustomer } from "~/hooks/use-customer-queries";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import type {
  CreateOfflineOrderRequest,
  CreateDraftOrderRequest,
  OfflineCustomerInput,
  OfflinePaymentMethod,
  OrderAddressInput,
} from "~/types/api";

type CustomerSelection = {
  customerId?: string;
  newCustomer?: OfflineCustomerInput;
};

/**
 * Shared form for both:
 *   - "Create order now" path (default, used by /orders/new)
 *   - "Save as draft" path (toggle visible when `allowDraft` is true)
 *
 * The two paths share validation; only the final submit differs.
 * `draftOnly` flips the form into draft-mode where the Save as draft button
 * is the primary action and the immediate-create button is hidden — used by
 * the dedicated /drafts/new route.
 */
export function OfflineOrderForm({
  allowDraft = true,
  draftOnly = false,
}: {
  allowDraft?: boolean;
  draftOnly?: boolean;
} = {}) {
  const navigate = useNavigate();
  const { data: org } = useCurrentOrg();
  const currency = org?.currency ?? "INR";
  const createOrder = useCreateOfflineOrderMutation();
  const createDraft = useCreateDraftOrderMutation();
  // The basis the server prices typed and catalogue prices on, so the preview
  // matches what is saved.
  const { data: settings } = useOrganizationSettings();

  const [customer, setCustomer] = useState<CustomerSelection>({});
  const [lines, setLines] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] =
    useState<OfflinePaymentMethod>("CASH");
  // Seeded from the location the merchant is working in, so a counter sale
  // deducts from the stock they were just looking at. An offline sale takes its
  // units from `dispatchWarehouseId ?? the org default`, so leaving this blank
  // used to ship from the default no matter which location was on screen.
  const { locations: activeWarehouses, locationId } = useSelectedLocation({
    sync: false,
  });
  const [warehouseId, setWarehouseId] = useState("");
  const dispatchWarehouseId = warehouseId || locationId || "";
  const [note, setNote] = useState("");
  const [shipTo, setShipTo] = useState<OrderAddressInput>({});
  const [billSame, setBillSame] = useState(true);
  const [billTo, setBillTo] = useState<OrderAddressInput>({});

  // Picking an existing customer pre-fills the delivery address from what the
  // CRM already knows (saved address, else their last order's). Only into an
  // EMPTY form — an address the merchant typed is never overwritten; they get
  // a "Use saved address" link instead.
  const { data: pickedCustomer } = useCustomer(customer.customerId);
  const savedAddress = customer.customerId ? pickedCustomer?.prefillAddress ?? null : null;
  const [autofilled, setAutofilled] = useState<OrderAddressInput | null>(null);

  useEffect(() => {
    if (!savedAddress || cleanAddress(shipTo)) return;
    setShipTo(savedAddress);
    setAutofilled(savedAddress);
    // Runs once per picked customer; `shipTo` is read, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCustomer?.id, savedAddress]);

  function handleCustomerChange(next: CustomerSelection) {
    // Unpicking the customer takes their address with them — unless the
    // merchant has edited it since, in which case it is theirs now.
    if (!next.customerId && autofilled && shipTo === autofilled) {
      setShipTo({});
    }
    setAutofilled(null);
    setCustomer(next);
  }

  function applySavedAddress() {
    if (!savedAddress) return;
    setShipTo(savedAddress);
    setAutofilled(savedAddress);
  }

  const customerName = pickedCustomer
    ? `${pickedCustomer.firstName ?? ""} ${pickedCustomer.lastName ?? ""}`.trim()
    : "";

  function addLine(seed: CartLineSeed) {
    setLines((prev) => {
      // If already in cart, bump quantity rather than duplicate.
      const existing = prev.find((l) => l.variantId === seed.variantId);
      if (existing) {
        return prev.map((l) =>
          l.variantId === seed.variantId
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }
      return [
        ...prev,
        {
          variantId: seed.variantId,
          productId: seed.productId,
          productTitle: seed.productTitle,
          variantTitle: seed.variantTitle,
          quantity: 1,
          unitPrice: seed.unitPrice,
          inventoryQuantity: seed.inventoryQuantity,
          gstRate: seed.gstRate,
          canOversell: seed.canOversell,
        },
      ];
    });
  }

  function updateLine(variantId: string, patch: Partial<CartLine>) {
    setLines((prev) =>
      prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(variantId: string) {
    setLines((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  const excludedVariantIds = useMemo(
    () => new Set(lines.map((l) => l.variantId)),
    [lines],
  );

  // Match the server's `resolveCustomer` rule: any one of customerId, email,
  // phone, firstName, or lastName is enough to identify the buyer.
  const nc = customer.newCustomer;
  const customerReady =
    !!customer.customerId ||
    !!(nc?.email || nc?.phone || nc?.firstName || nc?.lastName);
  const linesReady =
    lines.length > 0 && lines.every((l) => l.quantity > 0 && l.unitPrice >= 0);
  // A phone Shopify can't parse fails the whole order push ("Order Phone is
  // invalid"), so an invalid number blocks saving rather than being stored.
  const phonesValid =
    isPhoneValidOrEmpty(nc?.phone) &&
    isPhoneValidOrEmpty(shipTo.phone) &&
    (billSame || isPhoneValidOrEmpty(billTo.phone));
  // Stock is shown as an informational warning in the cart but does NOT block
  // submission — inventory tracking on offline orders is a follow-up task.
  const canSubmit = customerReady && linesReady && phonesValid;

  // Build a hint so the disabled state isn't a mystery.
  let disabledReason: string | null = null;
  if (!customerReady && lines.length === 0) {
    disabledReason = "Pick or create a customer and add at least one product.";
  } else if (!customerReady) {
    disabledReason =
      "Pick a customer, or fill in a name / email / phone for a new one.";
  } else if (!linesReady) {
    disabledReason = "Add at least one product with a quantity of 1 or more.";
  } else if (!phonesValid) {
    disabledReason = "Fix the phone number before saving.";
  }

  function buildCustomerBlock(): OfflineCustomerInput {
    return customer.customerId
      ? { customerId: customer.customerId }
      : customer.newCustomer ?? {};
  }

  /**
   * Shipping/billing as sent to the API. Both are `undefined` for a plain
   * counter sale, which keeps place of supply falling back to the seller's
   * state exactly as before this form captured addresses.
   */
  function buildAddresses() {
    const shipping = cleanAddress(shipTo);
    return {
      shippingAddress: shipping,
      billingAddress: billSame ? shipping : cleanAddress(billTo),
    };
  }

  function handleSubmit() {
    if (!canSubmit) return;
    const payload: CreateOfflineOrderRequest = {
      customer: buildCustomerBlock(),
      lineItems: lines.map((l) => ({
        productVariantId: l.variantId,
        quantity: l.quantity,
        unitPriceOverride: l.unitPrice,
      })),
      paymentMethod,
      warehouseId: dispatchWarehouseId || undefined,
      note: note || undefined,
      ...buildAddresses(),
    };

    createOrder.mutate(payload, {
      onSuccess: (result) => {
        if (result.invoice) {
          navigate(`/orders/invoices/${result.invoice.id}/print`);
        } else {
          navigate("/orders");
        }
      },
    });
  }

  function handleSaveDraft() {
    if (!canSubmit) return;
    const customerBlock = buildCustomerBlock();
    // Drop empty customer blocks — backend treats `customer: undefined` as
    // an anonymous draft, which is more permissive than the offline-order
    // path that requires identifiers.
    const customerOmit =
      !customerBlock.customerId &&
      !customerBlock.email &&
      !customerBlock.phone &&
      !customerBlock.firstName &&
      !customerBlock.lastName;

    const payload: CreateDraftOrderRequest = {
      customer: customerOmit ? undefined : customerBlock,
      lineItems: lines.map((l) => ({
        productVariantId: l.variantId,
        quantity: l.quantity,
        unitPriceOverride: l.unitPrice,
      })),
      note: note || undefined,
      ...buildAddresses(),
    };

    createDraft.mutate(payload, {
      onSuccess: (draft) => {
        navigate(`/orders/drafts/${draft.id}`);
      },
    });
  }

  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const { grandTotal } = billTotals(lines, settings?.pricesIncludeTax.effective ?? false);
  const submitting = createOrder.isPending || createDraft.isPending;

  return (
    <>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Section
          title="Customer"
          subtitle="Search an existing customer or create a new one. Existing customers (e.g. someone who bought online) keep their order history."
        >
          <CustomerPickerOrCreate
            value={customer}
            onChange={handleCustomerChange}
            currency={currency}
          />
        </Section>

        <Section
          title="Products"
          subtitle="Search and add the items being purchased. Adjust quantity or unit price inline."
        >
          <div className="space-y-3">
            <ProductPicker
              onAdd={addLine}
              currency={currency}
              excludedVariantIds={excludedVariantIds}
            />
            <OrderCart
              lines={lines}
              onUpdate={updateLine}
              onRemove={removeLine}
              currency={currency}
            />
          </div>
        </Section>

        <Section
          title="Delivery address"
          subtitle="Leave blank for a counter sale. For a delivered order the state here sets the GST place of supply — a different state from yours means IGST instead of CGST + SGST."
        >
          {autofilled && shipTo === autofilled ? (
            <p className="mb-2 rounded-md bg-muted px-2 py-1.5 text-caption text-muted-foreground">
              Filled from {customerName || "this customer"}'s saved address — edit it if this
              order goes somewhere else.
            </p>
          ) : savedAddress && shipTo !== savedAddress ? (
            <button
              type="button"
              onClick={applySavedAddress}
              className="mb-2 text-caption font-medium text-info hover:underline"
            >
              Use {customerName || "this customer"}'s saved address
            </button>
          ) : null}
          <AddressFields value={shipTo} onChange={setShipTo} />

          <label className="mt-3 flex items-center gap-2 text-caption text-gray-700 dark:text-gray-300 max-md:min-h-11 max-md:text-label pointer-coarse:min-h-11">
            <input
              type="checkbox"
              checked={billSame}
              onChange={(e) => setBillSame(e.target.checked)}
              className="rounded border-border"
            />
            Billing address is the same as delivery
          </label>

          {!billSame && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                Billing address
              </p>
              <AddressFields value={billTo} onChange={setBillTo} />
            </div>
          )}
        </Section>
      </div>

      <div className="lg:col-span-1">
        <div className="lg:sticky lg:top-6">
          <BillSummary
            lines={lines}
            currency={currency}
            paymentMethod={paymentMethod}
            onPaymentMethodChange={setPaymentMethod}
            warehouses={activeWarehouses}
            warehouseId={dispatchWarehouseId}
            onWarehouseChange={setWarehouseId}
            note={note}
            onNoteChange={setNote}
            isSubmitting={createOrder.isPending}
            canSubmit={canSubmit}
            disabledReason={disabledReason}
            onSubmit={handleSubmit}
            onSaveDraft={allowDraft ? handleSaveDraft : undefined}
            isSavingDraft={createDraft.isPending}
            draftOnly={draftOnly}
            pricesIncludeTax={settings?.pricesIncludeTax.effective ?? false}
          />
        </div>
      </div>
    </div>

    {/* Below 1024px the bill summary comes after the whole form, so the
        running total and the main button ride along at the bottom. */}
    <div className="mobile-action-dock sticky bottom-0 z-30 -mx-4 flex items-center gap-3 border-t bg-card/95 px-4 py-2.5 backdrop-blur lg:hidden">
      <p className="min-w-0 flex-1 leading-tight">
        <span className="line-clamp-2 text-caption text-muted-foreground">
          {!canSubmit && disabledReason
            ? disabledReason
            : `${itemCount} item${itemCount === 1 ? "" : "s"} · estimated total`}
        </span>
        <span className="block truncate text-section font-semibold tabular-nums">
          {formatCurrency(grandTotal, currency)}
        </span>
      </p>
      <Button
        variant="brand"
        className="h-11 shrink-0 rounded-xl px-4"
        disabled={!canSubmit || submitting}
        onClick={draftOnly ? handleSaveDraft : handleSubmit}
      >
        {draftOnly
          ? createDraft.isPending ? "Saving…" : "Save draft"
          : createOrder.isPending ? "Creating…" : "Create order"}
      </Button>
    </div>
    </>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl bg-card p-4 shadow-sm ring-1 ring-border sm:p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p className="text-caption text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}
