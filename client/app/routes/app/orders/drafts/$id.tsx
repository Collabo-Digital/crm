import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useListReturnPath } from "~/hooks/use-list-url-state";
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { useDraftOrder } from "~/hooks/use-draft-order-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import {
  useDeleteDraftOrderMutation,
  useCompleteDraftOrderMutation,
} from "~/hooks/use-draft-order-mutations";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SectionCard } from "~/components/app/section-card";
import { QueryErrorState } from "~/components/app/query-error-state";
import { cn, formatCurrency } from "~/lib/utils";
import { DRAFT_STATUS_CLASSES, DRAFT_STATUS_LABELS } from "~/lib/draft-status";
import {
  ModalShell,
  DialogFooter,
  CheckboxRow,
} from "~/components/app/order-dialog-primitives";
import type { OfflinePaymentMethod } from "~/types/api";

export function meta() {
  return [{ title: "Draft | Collabo CRM" }];
}

const PAYMENT_METHODS: ReadonlyArray<{ value: OfflinePaymentMethod; label: string }> = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
  { value: "OTHER", label: "Other" },
];

export default function DraftDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Back to the list as it was left: same page and search.
  const draftsPath = useListReturnPath("drafts", "/orders/drafts");
  const { data: draft, isLoading, isError, refetch } = useDraftOrder(id);
  const { data: org } = useCurrentOrg();
  const currency = draft?.currency ?? org?.currency ?? "INR";

  const deleteDraft = useDeleteDraftOrderMutation();
  const completeDraft = useCompleteDraftOrderMutation(id!);

  const [showComplete, setShowComplete] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // Must precede the spinner below: on failure `isLoading` is false and `draft`
  // undefined, so `isLoading || !draft` held the spinner on screen for ever
  // with no retry and no way out.
  if (isError && !draft) {
    return (
      <div className="p-8">
        <QueryErrorState resource="this draft" onRetry={() => refetch()} />
      </div>
    );
  }

  if (isLoading || !draft) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isCompleted = draft.status === "COMPLETED";
  const isShopify = draft.channel.platform === "SHOPIFY";
  const draftName = draft.name ?? `Draft ${draft.id.slice(-6)}`;

  return (
    <div className="space-y-6">
      {/* Breadcrumb + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-caption">
          <Link to={draftsPath} className="text-muted-foreground hover:text-foreground">
            Drafts
          </Link>
          <ChevronRight className="size-3 text-muted-foreground" />
          <span className="font-medium text-foreground">{draftName}</span>
        </nav>
        {!isCompleted && (
          <div className="flex items-center gap-2">
            <Button variant="destructive" size="action" onClick={() => setShowDelete(true)}>
              <Trash2 className="size-3.5" />
              Delete
            </Button>
            <Button variant="brand" size="action" onClick={() => setShowComplete(true)}>
              <CheckCircle2 className="size-3.5" />
              Complete draft
            </Button>
          </div>
        )}
      </div>

      {/* Title */}
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-subhead text-foreground">{draftName}</h1>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-micro font-medium",
              DRAFT_STATUS_CLASSES[draft.status],
            )}
          >
            {DRAFT_STATUS_LABELS[draft.status]}
          </span>
        </div>
        <p className="text-caption text-muted-foreground">
          Created {new Date(draft.createdAt).toLocaleString("en-IN")} • Updated{" "}
          {new Date(draft.updatedAt).toLocaleString("en-IN")}
          {draft.channel && ` • ${draft.channel.name}`}
        </p>
      </div>

      {/* Banner for completed drafts pointing to the resulting order */}
      {isCompleted && draft.completedOrder && (
        <div className="rounded-xl border border-brand bg-brand/10 px-4 py-3 text-caption">
          <p className="font-medium text-brand-strong">
            This draft was completed as order{" "}
            <Link
              to={`/orders/${draft.completedOrder.id}`}
              className="underline hover:no-underline inline-flex items-center gap-1"
            >
              {draft.completedOrder.name}
              <ExternalLink className="size-3" />
            </Link>
            .
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Customer */}
          <SectionCard title="Customer">
            <div className="px-5 py-4">
              {draft.customer ? (
                <div>
                  <p className="text-body font-medium text-foreground">
                    {(draft.customer.firstName ?? "") +
                      " " +
                      (draft.customer.lastName ?? "")}
                  </p>
                  {draft.customer.email && (
                    <p className="text-caption text-muted-foreground">
                      {draft.customer.email}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-caption text-muted-foreground italic">
                  Anonymous draft — no customer attached yet.
                </p>
              )}
            </div>
          </SectionCard>

          {/* Line items */}
          <SectionCard title={`Line items (${draft.lineItems.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-caption">
                <thead className="text-micro uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-5 py-2 text-left font-medium">Item</th>
                    <th className="px-5 py-2 text-right font-medium">Qty</th>
                    <th className="px-5 py-2 text-right font-medium">Unit price</th>
                    <th className="px-5 py-2 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {draft.lineItems.map((li) => (
                    <tr key={li.id}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-foreground">{li.title}</p>
                        {li.variantTitle && (
                          <p className="text-micro text-muted-foreground">
                            {li.variantTitle}
                          </p>
                        )}
                        {li.sku && (
                          <p className="text-micro font-mono text-muted-foreground">
                            SKU {li.sku}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {li.quantity}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {formatCurrency(li.price, currency)}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-semibold">
                        {formatCurrency(Number(li.price) * li.quantity, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* Totals */}
          <SectionCard title="Totals">
            <div className="space-y-1 px-5 py-4 text-caption">
              <Row
                label="Subtotal"
                value={formatCurrency(draft.subtotalPrice, currency)}
              />
              <Row label="Tax" value={formatCurrency(draft.totalTax, currency)} />
              {Number(draft.totalShippingPrice) > 0 && (
                <Row
                  label="Shipping"
                  value={formatCurrency(draft.totalShippingPrice, currency)}
                />
              )}
              <div className="mt-2 border-t pt-2">
                <Row
                  label="Estimated total"
                  value={formatCurrency(draft.totalPrice, currency)}
                  highlight="bold"
                />
              </div>
            </div>
          </SectionCard>

          {draft.note && (
            <SectionCard title="Note">
              <p className="whitespace-pre-wrap px-5 py-4 text-caption">{draft.note}</p>
            </SectionCard>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <SectionCard title="Status">
            <div className="space-y-2 px-5 py-4 text-caption">
              <DescRow label="Status" value={DRAFT_STATUS_LABELS[draft.status]} />
              <DescRow label="Items" value={String(draft.lineItems.length)} />
              {draft.completedAt && (
                <DescRow
                  label="Completed"
                  value={new Date(draft.completedAt).toLocaleDateString("en-IN")}
                />
              )}
              {draft.invoiceSentAt && (
                <DescRow
                  label="Invoice sent"
                  value={new Date(draft.invoiceSentAt).toLocaleDateString("en-IN")}
                />
              )}
              {draft.invoiceUrl && (
                <p className="text-micro">
                  <a
                    href={draft.invoiceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    Shopify invoice link
                    <ExternalLink className="size-3" />
                  </a>
                </p>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Channel">
            <div className="px-5 py-4">
              <p className="text-caption text-foreground">{draft.channel.name}</p>
              <p className="text-micro text-muted-foreground">
                {draft.channel.platform}
              </p>
              {isShopify && (
                <p className="mt-2 text-micro text-warning-strong">
                  Shopify drafts are not yet mirrored from this CRM — completion
                  is supported via the offline path for now.
                </p>
              )}
            </div>
          </SectionCard>
        </div>
      </div>

      {/* Complete dialog */}
      {showComplete && (
        <CompleteDraftDialog
          isPending={completeDraft.isPending}
          onClose={() => setShowComplete(false)}
          onSubmit={(payload) =>
            completeDraft.mutate(payload, {
              onSuccess: (result) => {
                setShowComplete(false);
                // No order yet = completed in Shopify, still syncing; the
                // Orders list is where it lands.
                navigate(result.order ? `/orders/${result.order.id}` : "/orders");
              },
            })
          }
        />
      )}

      {/* Delete confirm dialog */}
      {showDelete && (
        <ModalShell title="Delete this draft?" onClose={() => setShowDelete(false)}>
          <p className="px-6 py-4 text-caption text-muted-foreground">
            The draft will be removed from your list. This can't be undone.
          </p>
          <DialogFooter
            confirmLabel="Delete"
            confirmTone="destructive"
            onConfirm={() =>
              deleteDraft.mutate(draft.id, {
                onSuccess: () => navigate(draftsPath),
              })
            }
            onClose={() => setShowDelete(false)}
            pending={deleteDraft.isPending}
          />
        </ModalShell>
      )}
    </div>
  );
}

function CompleteDraftDialog({
  isPending,
  onClose,
  onSubmit,
}: {
  isPending: boolean;
  onClose: () => void;
  onSubmit: (data: {
    paymentMethod: OfflinePaymentMethod;
    generateInvoice: boolean;
  }) => void;
}) {
  const [paymentMethod, setPaymentMethod] =
    useState<OfflinePaymentMethod>("CASH");
  const [generateInvoice, setGenerateInvoice] = useState(true);

  return (
    <ModalShell title="Complete draft" onClose={onClose}>
      <div className="space-y-4 px-6 py-4">
        <p className="text-caption text-muted-foreground">
          Converts this draft into a finalized order. Inventory, customer
          counters, and (optionally) a GST invoice will all be created.
        </p>

        <div className="space-y-1">
          <label className="text-micro font-medium text-muted-foreground">
            Payment method
          </label>
          <Select
            value={paymentMethod}
            onValueChange={(next) => setPaymentMethod(next as OfflinePaymentMethod)}
          >
            <SelectTrigger className="h-9 w-full text-caption">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_METHODS.map((method) => (
                <SelectItem
                  key={method.value}
                  value={method.value}
                  className="text-caption"
                >
                  {method.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <CheckboxRow
          checked={generateInvoice}
          onChange={setGenerateInvoice}
          label="Generate GST invoice"
          help="Soft-fails if GSTIN isn't configured — completion still succeeds."
        />
      </div>
      <DialogFooter
        confirmLabel="Complete & create order"
        onConfirm={() => onSubmit({ paymentMethod, generateInvoice })}
        onClose={onClose}
        pending={isPending}
      />
    </ModalShell>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "bold";
}) {
  return (
    <div className="flex justify-between">
      <span
        className={cn(
          "text-muted-foreground",
          highlight === "bold" && "font-semibold text-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn("tabular-nums", highlight === "bold" && "font-semibold")}
      >
        {value}
      </span>
    </div>
  );
}

function DescRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
