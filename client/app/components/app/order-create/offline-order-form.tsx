import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCreateOfflineOrderMutation } from "~/hooks/use-order-mutations";
import { useCreateDraftOrderMutation } from "~/hooks/use-draft-order-mutations";
import { CustomerPickerOrCreate } from "./customer-picker-or-create";
import { ProductPicker, type CartLineSeed } from "./product-picker";
import { OrderCart, type CartLine } from "./order-cart";
import { BillSummary } from "./bill-summary";
import { AddressFields, cleanAddress } from "./address-fields";
import { useSelectedLocation } from "~/hooks/use-selected-location";
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
  // Stock is shown as an informational warning in the cart but does NOT block
  // submission — inventory tracking on offline orders is a follow-up task.
  const canSubmit = customerReady && linesReady;

  // Build a hint so the disabled state isn't a mystery.
  let disabledReason: string | null = null;
  if (!customerReady && lines.length === 0) {
    disabledReason = "Pick or create a customer and add at least one product.";
  } else if (!customerReady) {
    disabledReason =
      "Pick a customer, or fill in a name / email / phone for a new one.";
  } else if (!linesReady) {
    disabledReason = "Add at least one product with a quantity of 1 or more.";
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Section
          title="Customer"
          subtitle="Search an existing customer or create a new one. Existing customers (e.g. someone who bought online) keep their order history."
        >
          <CustomerPickerOrCreate
            value={customer}
            onChange={setCustomer}
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
          <AddressFields value={shipTo} onChange={setShipTo} />

          <label className="mt-3 flex items-center gap-2 text-[11px] text-gray-700 dark:text-gray-300">
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
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Billing address
              </p>
              <AddressFields value={billTo} onChange={setBillTo} />
            </div>
          )}
        </Section>
      </div>

      <div className="lg:col-span-1">
        <div className="sticky top-6">
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
          />
        </div>
      </div>
    </div>
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
    <section className="rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}
