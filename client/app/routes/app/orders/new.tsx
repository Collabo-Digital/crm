import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { OfflineOrderForm } from "~/components/app/order-create/offline-order-form";

export function meta() {
  return [
    { title: "Create Order | Collabo CRM" },
    {
      name: "description",
      content: "Create an offline (in-store) order and generate the GST bill.",
    },
  ];
}

export default function NewOrderPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* On a phone the app bar's back arrow does this job. */}
          <Link
            to="/orders"
            className="mb-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100 max-md:hidden"
          >
            <ArrowLeft className="size-3.5" />
            Back to orders
          </Link>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            Create Order
          </h1>
          <p className="text-sm text-muted-foreground">
            For walk-in / counter sales — captures the customer, line items and
            generates the GST invoice in one step.
          </p>
        </div>
      </div>

      <OfflineOrderForm />
    </div>
  );
}
