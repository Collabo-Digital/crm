import { CircleCheck, CircleX, ScanBarcode, TriangleAlert } from "lucide-react";
import type { FeedbackTone } from "~/lib/packing";
import { cn } from "~/lib/utils";

export interface ShownFeedback {
  tone: FeedbackTone;
  title: string;
  detail?: string;
  at: number;
}

// Solid fills so a packer can read it from arm's length. Ink on green and amber
// (white on green is only 3.2:1); white on red, flipping to ink in dark mode
// where the red turns light.
const TONE: Record<FeedbackTone, string> = {
  success: "bg-success text-ink",
  warning: "bg-warning text-ink",
  danger: "bg-danger text-ink-foreground dark:text-ink",
};

const ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleX };

/** The last scan's result, full width: green, amber or red. */
export function ScanBanner({ feedback, idle }: { feedback: ShownFeedback | null; idle: string }) {
  if (!feedback) {
    return (
      <p role="status" className="flex items-center gap-3 rounded-xl bg-muted px-4 py-3 text-body text-muted-foreground">
        <ScanBarcode className="size-5 shrink-0" />
        {idle}
      </p>
    );
  }
  const Icon = ICON[feedback.tone];
  return (
    <div
      key={feedback.at}
      role={feedback.tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-xl px-4 py-3 animate-in fade-in-0 zoom-in-95", TONE[feedback.tone])}
    >
      <Icon className="mt-0.5 size-6 shrink-0" />
      <div className="min-w-0">
        <p className="text-section [overflow-wrap:anywhere]">{feedback.title}</p>
        {feedback.detail && <p className="text-body opacity-90">{feedback.detail}</p>}
      </div>
    </div>
  );
}
