import { Fragment } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Info, TriangleAlert } from "lucide-react";

import { TemplateEditor } from "~/components/app/campaigns/template-editor";
import { TemplatePreview } from "~/components/app/campaigns/template-preview";
import { ManagedBadge, QualityDot, TemplateCategoryLabel, TemplateStatusBadge } from "~/components/app/campaigns/template-status";
import { QueryErrorState } from "~/components/app/query-error-state";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useSaveTemplateMutation } from "~/hooks/use-campaign-mutations";
import { useTemplate } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { formatDateTime } from "~/lib/format-date";
import { approvedAsMarketing, packSlotTitle } from "~/lib/template-pack";

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
  const rejection = template.status === "REJECTED" ? template.rejectionInfo : null;

  return (
    <div className="space-y-6">
      <Link to="/campaigns/templates" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Templates
      </Link>
      <PageHeader data-mobile-title>
        <PageHeaderContent>
          <PageHeaderTitle className="flex flex-wrap items-center gap-3 font-mono">
            {/* Long names (collabo_cod_confirm_v1) wrap after an underscore on a phone. */}
            <span className="min-w-0 break-words">
              {template.name.split("_").map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <>
                      _<wbr />
                    </>
                  )}
                  {part}
                </Fragment>
              ))}
            </span>
            <TemplateStatusBadge status={template.status} />
            {template.packSlot && <ManagedBadge />}
          </PageHeaderTitle>
          <PageHeaderDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <TemplateCategoryLabel template={template} />
            <span>{template.language}</span>
            <QualityDot score={template.qualityScore} />
            {template.syncedAt && <span>Synced {formatDateTime(template.syncedAt)}</span>}
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {rejection?.reason || rejection?.recommendation ? (
        <div className="space-y-1 rounded-lg bg-danger-subtle px-4 py-3 text-caption">
          {rejection.reason && <p className="text-danger">Meta’s reason: {rejection.reason}</p>}
          {rejection.recommendation && <p className="text-foreground">Meta recommends: {rejection.recommendation}</p>}
          <p className="text-muted-foreground">{editable ? "Edit the content and submit it again." : "Ask someone who manages templates to edit it and submit it again."}</p>
        </div>
      ) : (
        template.statusReason && (
          <p className="rounded-lg bg-danger-subtle px-4 py-3 text-caption text-danger">
            Meta’s reason: {template.statusReason.toLowerCase().replace(/_/g, " ")}. Edit the content and submit it again.
          </p>
        )
      )}

      {approvedAsMarketing(template) && (
        <Alert variant="warning">
          <Info />
          <div className="space-y-0.5">
            <AlertTitle>Approved as marketing</AlertTitle>
            <AlertDescription>
              It was submitted as a utility message, but Meta filed it under marketing. Meta charges more for marketing messages and may not deliver them to people who get many,
              and automations hold them between 9 PM and 9 AM (store time).
              {template.packSlot && " When Collabo has another wording for it, Collabo submits that one by itself; until then it keeps sending this one."}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {template.packSlot && editable && (
        <Alert variant="warning">
          <TriangleAlert />
          <div className="space-y-0.5">
            <AlertTitle>Collabo manages this template</AlertTitle>
            <AlertDescription>
              It is Collabo’s “{packSlotTitle(template.packSlot)}” template, and automations send it with their own values for each variable. If you edit it, keep its
              variables and buttons as they are: Meta reviews it again, and the automations skip it until Meta approves the change. Deleting it stops the automations that send it.
            </AlertDescription>
          </div>
        </Alert>
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
