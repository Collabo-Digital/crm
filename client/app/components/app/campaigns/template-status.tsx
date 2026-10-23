import { CATEGORY_LABEL, QUALITY_DOT, QUALITY_LABEL, TEMPLATE_STATUS_LABEL, templateStatusClass } from "~/lib/campaign-format";
import { cn } from "~/lib/utils";
import type { MessageTemplate } from "~/types/api";

export function TemplateStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 w-fit items-center whitespace-nowrap rounded-full px-2 text-micro font-medium", templateStatusClass(status), className)}>
      {TEMPLATE_STATUS_LABEL[status] ?? status.toLowerCase()}
    </span>
  );
}

/** Category, and a note when Meta filed it under a different one than asked. */
export function TemplateCategoryLabel({ template }: { template: Pick<MessageTemplate, "category" | "requestedCategory"> }) {
  return (
    <span className="text-caption text-muted-foreground" title={template.requestedCategory ? `Submitted as ${CATEGORY_LABEL[template.requestedCategory]}; Meta approved it as ${CATEGORY_LABEL[template.category]}.` : undefined}>
      {CATEGORY_LABEL[template.category]}
      {template.requestedCategory && " · recategorised"}
    </span>
  );
}

export function QualityDot({ score }: { score: string | null }) {
  if (!score) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground" title={QUALITY_LABEL[score] ?? score}>
      <span className={cn("size-2 rounded-full", QUALITY_DOT[score] ?? QUALITY_DOT.UNKNOWN)} />
      {QUALITY_LABEL[score] ?? score}
    </span>
  );
}
