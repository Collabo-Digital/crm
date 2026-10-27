import { useState } from "react";
import { isAxiosError } from "axios";
import { Loader2 } from "lucide-react";

import { PdfPages } from "~/components/app/pdf-pages";
import { Button } from "~/components/ui/button";
import { useInvoicePreview } from "~/hooks/use-settings-queries";
import { SAMPLE_LABELS } from "~/lib/invoice-settings";
import { cn } from "~/lib/utils";
import type { InvoiceSample, UpdateInvoiceSettingsRequest } from "~/types/api";

/** The server's sentence for a refused preview; its body arrives as bytes, like the PDF it replaced. */
function previewProblem(error: unknown): string {
  const data = isAxiosError(error) ? error.response?.data : undefined;
  if (data instanceof ArrayBuffer) {
    try {
      const body = JSON.parse(new TextDecoder().decode(data)) as { message?: unknown; errors?: unknown };
      const detail = Array.isArray(body.errors) && typeof body.errors[0] === "string" ? body.errors[0] : null;
      if (detail) return detail;
      if (typeof body.message === "string" && body.message) return body.message;
    } catch {
      // Not JSON: fall through to the general sentence.
    }
  }
  return "The preview couldn't be made. Check your connection and try again.";
}

interface InvoicePreviewProps {
  sample: InvoiceSample;
  samples: InvoiceSample[];
  onSample: (sample: InvoiceSample) => void;
  /** The unsaved form, as `previewSettings` makes it. */
  settings: UpdateInvoiceSettingsRequest;
  /** Previews are for members who can change the settings; the server refuses the rest. */
  canPreview: boolean;
  /** The server draws the real seller when GST is on with a GSTIN, else a sample one. */
  hasSeller: boolean;
  /** Caps the drawn pages' height, scrolling inside it. */
  pagesClassName?: string;
}

/**
 * A sample document drawn by the server with the unsaved form, so the preview
 * is the PDF itself rather than a copy of it.
 */
export function InvoicePreview({ sample, samples, onSample, settings, canPreview, hasSeller, pagesClassName }: InvoicePreviewProps) {
  const preview = useInvoicePreview(sample, settings, canPreview);
  const [drawFailed, setDrawFailed] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label htmlFor="invoice-preview-sample" className="text-label">
          Sample
        </label>
        <select
          id="invoice-preview-sample"
          value={sample}
          onChange={(e) => onSample(e.target.value as InvoiceSample)}
          disabled={!canPreview}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-body"
        >
          {samples.map((s) => (
            <option key={s} value={s}>
              {SAMPLE_LABELS[s]}
            </option>
          ))}
        </select>
        <span className="flex w-24 shrink-0 items-center justify-end gap-1.5 text-micro text-muted-foreground" aria-live="polite">
          {preview.isFetching && (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Updating
            </>
          )}
        </span>
      </div>

      {!canPreview ? (
        <p className="rounded-xl bg-muted/50 p-6 text-center text-caption text-muted-foreground">
          Only owners, admins and managers can preview invoice designs.
        </p>
      ) : (
        <>
          {(preview.isError || drawFailed) && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-caption text-danger">
              <span>{drawFailed ? "The preview couldn't be shown." : previewProblem(preview.error)}</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setDrawFailed(false);
                  void preview.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          )}
          <div className={cn("rounded-xl bg-muted/60 p-3", pagesClassName)}>
            <PdfPages
              data={preview.data}
              label={`Sample ${SAMPLE_LABELS[sample].toLowerCase()}`}
              onRendered={() => setDrawFailed(false)}
              onError={() => setDrawFailed(true)}
            />
          </div>
          <p className="text-micro text-muted-foreground">
            {hasSeller
              ? "A sample customer and items, with your business details."
              : "A sample customer and items. Your GSTIN and address appear once GST is set up in Tax & GST."}
          </p>
        </>
      )}
    </div>
  );
}
