import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, FilePlus } from "lucide-react";

import { TemplateEditor } from "~/components/app/campaigns/template-editor";
import { TemplatePreview } from "~/components/app/campaigns/template-preview";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { useSaveTemplateMutation } from "~/hooks/use-campaign-mutations";
import { useTemplateStarters } from "~/hooks/use-campaign-queries";
import { CATEGORY_LABEL, renderDraft } from "~/lib/campaign-format";
import type { TemplateDraft, TemplateStarter } from "~/types/api";

export function meta() {
  return [{ title: "New template | Collabo CRM" }];
}

const BLANK: TemplateDraft = { name: "", language: "en", category: "MARKETING", parameterFormat: "POSITIONAL", body: { text: "", examples: {} } };

const USE_CASE_LABEL: Record<TemplateStarter["useCase"], string> = {
  orders: "Orders",
  shipping: "Shipping",
  payments: "Payments",
  recovery: "Win back",
  promotions: "Promotions",
  engagement: "Engagement",
};

/** Pick a starter (or a blank page), then edit and submit for Meta's review. */
export default function NewTemplatePage() {
  const navigate = useNavigate();
  const { data: starters = [] } = useTemplateStarters();
  const save = useSaveTemplateMutation();
  const [chosen, setChosen] = useState<{ draft: TemplateDraft; starterKey?: string } | null>(null);

  return (
    <div className="space-y-6">
      <Link to="/campaigns/templates" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Templates
      </Link>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>New template</PageHeaderTitle>
          <PageHeaderDescription>{chosen ? "Make it yours, then submit it for Meta’s review." : "Start from a ready-made message or from a blank page."}</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {chosen ? (
        <TemplateEditor
          initial={chosen.draft}
          mode="create"
          isSubmitting={save.isPending}
          onSubmit={(draft) => save.mutate({ draft, starterKey: chosen.starterKey }, { onSuccess: (t) => navigate(`/campaigns/templates/${t.id}`) })}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <button
            type="button"
            onClick={() => setChosen({ draft: BLANK })}
            className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-muted-foreground hover:border-brand hover:text-foreground"
          >
            <FilePlus className="size-6" />
            <span className="text-body font-medium">Blank template</span>
          </button>
          {starters.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setChosen({ draft: { ...s.draft, language: "en" }, starterKey: s.key })}
              className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-left hover:border-brand hover:shadow-sm"
            >
              <div>
                <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                  {USE_CASE_LABEL[s.useCase]} · {CATEGORY_LABEL[s.draft.category]}
                </p>
                <p className="mt-1 text-body font-semibold">{s.title}</p>
                <p className="text-caption text-muted-foreground">{s.description}</p>
              </div>
              <TemplatePreview render={renderDraft({ ...s.draft, language: "en" })} buttonKinds={s.draft.buttons?.map((b) => b.type)} className="max-w-none" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
