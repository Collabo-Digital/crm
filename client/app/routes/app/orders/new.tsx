import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { OfflineOrderForm } from "~/components/app/order-create/offline-order-form";
import { useSectionAccess } from "~/hooks/use-section-access";

export function meta() {
  return [
    { title: "Create Order | Collabo CRM" },
    {
      name: "description",
      content: "Create a manual order and generate the GST bill.",
    },
  ];
}

export default function NewOrderPage() {
  const { canAccess } = useSectionAccess();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/orders"
            className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to orders
          </Link>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            Create Order
          </h1>
          {/* Not "walk-in / counter sales": only Point of sale bills count as
              in-store in Store reports and the dashboard, so a counter sale
              entered here used to go missing from both. */}
          <p className="text-sm text-muted-foreground">
            For orders you take by phone, on WhatsApp or by hand — captures the
            customer, line items and the GST invoice in one step.
          </p>
          {canAccess("/orders/pos") && (
          <p className="text-sm text-muted-foreground">
            Selling at the counter?{" "}
            <Link to="/orders/pos" className="font-medium text-brand-strong underline-offset-3 hover:underline">
              Use Point of sale
            </Link>
            , so the sale counts in Store reports and the dashboard's in-store sales.
          </p>
          )}
        </div>
      </div>

      <OfflineOrderForm />
    </div>
  );
}
