import { Link } from "react-router";
import { SearchX } from "lucide-react";

import { EmptyState } from "~/components/app/empty-state";
import { Button } from "~/components/ui/button";
import { useSectionAccess } from "~/hooks/use-section-access";

export function meta() {
  return [{ title: "Page not found | Collabo CRM" }];
}

/** Any URL no route claims: a mistyped or old link, inside the app's chrome. */
export default function NotFoundPage() {
  const { landingPath } = useSectionAccess();
  return (
    <div className="py-16">
      <EmptyState
        icon={SearchX}
        title="Page not found"
        description="This link is mistyped, or the page it pointed to has moved or been removed."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to={landingPath}>Go to your workspace</Link>
          </Button>
        }
      />
    </div>
  );
}
