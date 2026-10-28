import { useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  useConfirmImportMutation,
  useStartImportMutation,
} from "~/hooks/use-product-mutations";
import type { ProductImportJob } from "~/types/api";
import { ModalFrame, ModalTitle } from "~/components/app/order-dialog-primitives";

type WizardStep = "upload" | "preview" | "running" | "done";

/**
 * Three-step CSV import wizard:
 *   1. upload  — drag-drop a Shopify-format CSV; backend returns first 10 rows
 *   2. preview — confirm the column mapping, click Start to ingest
 *   3. running/done — show counts, errors, dismiss
 *
 * The original File is held in component state because the server's confirm
 * step needs to re-receive it (we don't persist the full CSV in the job row).
 */
export function CsvImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<WizardStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<ProductImportJob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startMutation = useStartImportMutation();
  const confirmMutation = useConfirmImportMutation();
  const descriptionId = useId();

  function handleFileChosen(f: File) {
    setFile(f);
    startMutation.mutate(f, {
      onSuccess: (j) => {
        setJob(j);
        setStep("preview");
      },
    });
  }

  function handleConfirm() {
    if (!file || !job) return;
    setStep("running");
    confirmMutation.mutate(
      { jobId: job.id, file },
      {
        onSuccess: (j) => {
          setJob(j);
          setStep("done");
        },
        onError: () => setStep("preview"),
      },
    );
  }

  return (
    <ModalFrame
      onClose={onClose}
      describedBy={descriptionId}
      className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl outline-none"
    >
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <ModalTitle className="text-sm font-bold text-gray-900 dark:text-gray-100">
              Import products from CSV
            </ModalTitle>
            <p id={descriptionId} className="text-[10px] text-muted-foreground">
              Shopify-format CSV. Each Handle becomes a product; multiple rows
              with the same Handle become variants of that product.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="size-4" />
          </button>
        </header>

        <ol className="flex items-center gap-2 border-b px-6 py-3 text-[10px] uppercase tracking-wider">
          <Step active={step === "upload"} done={step !== "upload"}>1. Upload</Step>
          <span className="text-muted-foreground">→</span>
          <Step active={step === "preview"} done={step === "running" || step === "done"}>
            2. Preview
          </Step>
          <span className="text-muted-foreground">→</span>
          <Step active={step === "running" || step === "done"} done={step === "done"}>
            3. Import
          </Step>
        </ol>

        <div className="px-6 py-5">
          {step === "upload" && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFileChosen(f);
              }}
              disabled={startMutation.isPending}
              className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-input bg-gray-50 dark:bg-gray-800/40 p-12 text-xs text-muted-foreground hover:border-[#CEF17B] hover:bg-[#CEF17B]/5 disabled:opacity-50"
            >
              {startMutation.isPending ? (
                <>
                  <Loader2 className="size-6 animate-spin" />
                  Parsing CSV…
                </>
              ) : (
                <>
                  <UploadCloud className="size-8 text-muted-foreground" />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Drop your CSV here or click to upload
                  </span>
                  <span className="text-[10px]">
                    Tip: export from another store via Shopify Admin → Products → Export
                  </span>
                </>
              )}
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileChosen(f);
            }}
          />

          {step === "preview" && job && (
            <div className="space-y-4">
              <div className="rounded-lg border border-input bg-gray-50 dark:bg-gray-800/40 px-3 py-2 flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  {job.filename}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  ({job.totalRows} rows)
                </span>
              </div>

              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Preview (first {job.previewRows.length} row{job.previewRows.length === 1 ? "" : "s"})
                </p>
                <div className="overflow-x-auto rounded-lg border border-input">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50/60 dark:bg-gray-800/60">
                      <tr>
                        {previewColumns(job.previewRows).map((col) => (
                          <th
                            key={col}
                            className="whitespace-nowrap px-2 py-2 text-left font-medium text-muted-foreground"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {job.previewRows.map((row, i) => (
                        <tr key={i}>
                          {previewColumns(job.previewRows).map((col) => (
                            <td
                              key={col}
                              className="whitespace-nowrap px-2 py-1.5 text-gray-900 dark:text-gray-100 max-w-[200px] truncate"
                              title={row[col]}
                            >
                              {row[col] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="rounded-lg bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-[11px] text-blue-800 dark:text-blue-200">
                We'll create products on your MANUAL channel. Already-imported
                products with the same Handle won't be deduplicated in this
                version — re-running the import creates duplicates.
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirmMutation.isPending}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:opacity-50"
                >
                  <Download className="size-3.5" />
                  Import {job.totalRows} row{job.totalRows === 1 ? "" : "s"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep("upload");
                    setFile(null);
                    setJob(null);
                  }}
                  className="rounded-lg px-4 py-2 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  Choose different file
                </button>
              </div>
            </div>
          )}

          {step === "running" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Importing…
              </p>
              <p className="text-[10px] text-muted-foreground">
                Don't close this window.
              </p>
            </div>
          )}

          {step === "done" && job && (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-2 rounded-lg border border-input bg-gray-50 dark:bg-gray-800/40 px-3 py-3">
                {job.errorCount === 0 ? (
                  <>
                    <Check className="size-5 text-green-600" />
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Imported {job.createdCount} product{job.createdCount === 1 ? "" : "s"}.
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="size-5 text-amber-600" />
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Imported {job.createdCount}, {job.errorCount} error{job.errorCount === 1 ? "" : "s"}.
                    </span>
                  </>
                )}
              </div>

              {job.errors.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Errors
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-input">
                    <table className="w-full text-[11px]">
                      <thead className="bg-gray-50/60 dark:bg-gray-800/60">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-16">Row</th>
                          <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-32">Handle</th>
                          <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Message</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {job.errors.map((e, i) => (
                          <tr key={i}>
                            <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                              {e.row || "—"}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                              {e.handle ?? "—"}
                            </td>
                            <td className="px-2 py-1.5 text-red-700 dark:text-red-400">
                              {e.message}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F]"
              >
                Done
              </button>
            </div>
          )}
        </div>
    </ModalFrame>
  );
}

function Step({
  children,
  active,
  done,
}: {
  children: React.ReactNode;
  active: boolean;
  done: boolean;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold ${
        active
          ? "bg-[#CEF17B]/30 text-[#084734]"
          : done
            ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
            : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Pick the most informative columns for the preview table from whatever the
 * server returned. Caps at 8 columns so the modal doesn't overflow.
 */
function previewColumns(rows: Record<string, string>[]): string[] {
  const PRIORITY = [
    "Handle",
    "Title",
    "Vendor",
    "Type",
    "Variant SKU",
    "Variant Price",
    "Variant Inventory Qty",
    "Status",
    "Image Src",
  ];
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  // Sort by priority, then by appearance.
  cols.sort((a, b) => {
    const ai = PRIORITY.indexOf(a);
    const bi = PRIORITY.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return cols.slice(0, 8);
}
