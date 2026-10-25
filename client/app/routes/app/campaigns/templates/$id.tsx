import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";

import { TemplateEditor } from "~/components/app/campaigns/template-editor";
import { TemplatePreview } from "~/components/app/campaigns/template-preview";
import { QualityDot, TemplateCategoryLabel, TemplateStatusBadge } from "~/components/app/campaigns/template-status";
import { QueryErrorState } from "~/components/app/query-error-state";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useSaveTemplateMutation } from "~/hooks/use-campaign-mutations";
import { useTemplate } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { formatDateTime } from "~/lib/format-date";

export function meta() {
  return [{ title: "Template | Collabo CRM" }];
}

/** One template: its status at Meta and, where Meta allows it, an editor. */
export default function TemplatePage() {
  const { id } = useParams();
  const { data: template, isLoading, isError, refetch } = useTemplate(id);
  const save = useSaveTemplateMutation();
  const { can } = useCurrentRole();

  if (isError) return <QueryErrorState resource="this template" onRetry={() => void refetch()} />;
  if (isLoading || !template) return <Skeleton className="h-96 w-full rounded-xl" />;

  const editable = template.editable && can("templates.manage");

  return (
    <div className="space-y-6">
      <Link to="/campaigns/templates" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Templates
      </Link>
      <PageHeader data-mobile-title>
        <PageHeaderContent>
          <PageHeaderTitle className="flex flex-wrap items-center gap-3 font-mono">
            {template.name}
            <TemplateStatusBadge status={template.status} />
          </PageHeaderTitle>
          <PageHeaderDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <TemplateCategoryLabel template={template} />
            <span>{template.language}</span>
            <QualityDot score={template.qualityScore} />
            {template.syncedAt && <span>Synced {formatDateTime(template.syncedAt)}</span>}
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {template.statusReason && (
        <p className="rounded-lg bg-danger-subtle px-4 py-3 text-caption text-danger">
          Meta’s reason: {template.statusReason.toLowerCase().replace(/_/g, " ")}. Edit the content and submit it again.
        </p>
      )}

      {editable ? (
        <TemplateEditor
          key={template.updatedAt}
          initial={template.draft}
          mode="edit"
          isSubmitting={save.isPending}
          onSubmit={(draft) => save.mutate({ id: template.id, draft })}
        />
      ) : (
        <div className="space-y-2">
          <TemplatePreview render={template.preview} buttonKinds={template.draft.buttons?.map((b) => b.type)} />
          <p className="text-caption text-muted-foreground">
            {template.status === "PENDING" ? "In review at Meta. It can be edited once Meta decides." : "Meta does not allow editing a template in this state."}
          </p>
        </div>
      )}
    </div>
  );
}
