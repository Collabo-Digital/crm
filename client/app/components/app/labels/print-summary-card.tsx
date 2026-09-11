/**
 * The bottom of the rail: what is wrong, what to set in the browser's print
 * dialog, and the button.
 *
 * The warnings replace three stacked paragraphs and a set of `title` attributes
 * that no one could see on a touch device. Each one states the problem in the
 * merchant's terms and, where there is a real fix, offers it.
 */
import { AlertTriangle, Info, Loader2, Printer, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

export type WarningTone = "danger" | "warning" | "info";

export interface LabelWarning {
  id: string;
  tone: WarningTone;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void; pending?: boolean };
}

const ICON: Record<WarningTone, typeof Info> = {
  danger: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export function PrintWarnings({ warnings }: { warnings: LabelWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {warnings.map((w) => {
        const Icon = ICON[w.tone];
        return (
          <Alert
            key={w.id}
            variant={w.tone === "info" ? "default" : w.tone}
            className="flex-col gap-1.5"
          >
            <div className="flex gap-3">
              <Icon />
              <div className="min-w-0 flex-1">
                <AlertTitle>{w.title}</AlertTitle>
                <AlertDescription className="mt-0.5 leading-relaxed">
                  {w.body}
                </AlertDescription>
              </div>
            </div>
            {w.action && (
              <div className="pl-7">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={w.action.pending}
                  onClick={w.action.onClick}
                >
                  {w.action.pending && <Loader2 className="size-3.5 animate-spin" />}
                  {w.action.label}
                </Button>
              </div>
            )}
          </Alert>
        );
      })}
    </div>
  );
}

export function PrintSettingsCard({
  settings,
}: {
  settings: Array<{ key: string; value: string }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 text-label text-foreground">Before you print</h3>
      <dl className="space-y-1.5 text-caption">
        {settings.map((s) => (
          <div key={s.key} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{s.key}</dt>
            <dd className="text-right font-medium text-foreground">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2.5 text-caption leading-relaxed text-muted-foreground">
        Set these in the print dialog your browser opens next. &ldquo;Fit to
        page&rdquo; stretches the bars and scanners stop reading them.
      </p>
    </div>
  );
}

export function PrintAction({
  total,
  readyNote,
  onPrint,
}: {
  total: number;
  readyNote: string;
  onPrint: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-caption text-muted-foreground">{readyNote}</p>
      <Button
        variant="accent"
        size="lg"
        className="w-full"
        disabled={total === 0}
        onClick={onPrint}
      >
        <Printer className="size-4" />
        {total === 0
          ? "Nothing to print"
          : `Print ${total.toLocaleString()} label${total === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}
