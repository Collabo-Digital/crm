import { Link } from "react-router";
import { useListReturnPath } from "~/hooks/use-list-url-state";
import { ChevronRight } from "lucide-react";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
} from "~/components/ui/page-header";
import { OfflineOrderForm } from "~/components/app/order-create/offline-order-form";

export function meta() {
  return [
    { title: "New draft | Collabo CRM" },
    {
      name: "description",
      content: "Compose a draft order or quote. Save it now, complete later.",
    },
  ];
}

/**
 * Dedicated "New draft" page. Reuses the same form as `/orders/new` but
 * with `draftOnly` set — the Create-immediately button is hidden so the
 * only path forward is to save the work as a draft.
 */
export default function NewDraftPage() {
  const draftsPath = useListReturnPath("drafts", "/orders/drafts");
  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-caption">
        <Link to={draftsPath} className="text-muted-foreground hover:text-foreground">
          Drafts
        </Link>
        <ChevronRight className="size-3 text-muted-foreground" />
        <span className="font-medium text-foreground">New draft</span>
      </nav>

      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>New draft</PageHeaderTitle>
          <PageHeaderDescription>
            Compose an in-progress order. Save now, edit anytime, then complete
            to turn it into a real order.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      <OfflineOrderForm draftOnly />
    </div>
  );
}
