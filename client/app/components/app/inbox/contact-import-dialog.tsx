import { useRef, useState } from "react";
import { Loader2, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useContactImportMutation } from "~/hooks/use-campaign-mutations";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { campaignsService } from "~/services/campaigns.service";
import type { ContactImportPreview, ContactImportResult } from "~/types/api";

const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-body";

/** The column whose header looks like `pattern`, to pre-fill the mapping. */
const guess = (headers: string[], pattern: RegExp) => headers.find((h) => pattern.test(h)) ?? "";

/**
 * Bring contacts in from a spreadsheet (CSV). Matched to existing contacts
 * by phone number: filled cells update them, tags are added, blank cells
 * leave what is there, and an opt-out is never overridden.
 */
export function ContactImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ContactImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapping, setMapping] = useState({ phone: "", name: "", tags: "", optIn: "" });
  const [attributes, setAttributes] = useState<Array<{ key: string; column: string }>>([]);
  const [countryCode, setCountryCode] = useState("91");
  const [extraTags, setExtraTags] = useState("");
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const run = useContactImportMutation();

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setAttributes([]);
    setConsent(false);
  }

  async function choose(f: File) {
    setLoading(true);
    try {
      const p = await campaignsService.previewImport(f);
      setFile(f);
      setPreview(p);
      setMapping({
        phone: guess(p.headers, /phone|mobile|whatsapp|number/i),
        name: guess(p.headers, /name/i),
        tags: guess(p.headers, /tag/i),
        optIn: guess(p.headers, /consent|opt/i),
      });
    } catch (error) {
      handleMutationError(error, "That file could not be read.");
    } finally {
      setLoading(false);
    }
  }

  function submit() {
    if (!file || !mapping.phone) return;
    run.mutate(
      {
        file,
        mapping: {
          phone: mapping.phone,
          ...(mapping.name ? { name: mapping.name } : {}),
          ...(mapping.tags ? { tags: mapping.tags } : {}),
          ...(mapping.optIn ? { optIn: mapping.optIn } : {}),
          ...(attributes.length ? { attributes: Object.fromEntries(attributes.filter((a) => a.key && a.column).map((a) => [a.key, a.column])) } : {}),
        },
        options: {
          ...(countryCode ? { defaultCountryCode: countryCode } : {}),
          tags: extraTags.split(",").map((t) => t.trim()).filter(Boolean),
          markOptedIn: consent,
        },
      },
      { onSuccess: setResult },
    );
  }

  const columnSelect = (value: string, onChange: (v: string) => void, label: string, required = false) => (
    <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{required ? "Choose a column" : "Not in the file"}</option>
      {preview?.headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>A CSV with a header row and one contact per row, up to 10,000 rows. They are added to your WhatsApp number.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-body">
              <span className="font-semibold">{result.created}</span> added, <span className="font-semibold">{result.updated}</span> updated
              {result.skipped > 0 && (
                <>
                  , <span className="font-semibold text-danger">{result.skipped}</span> skipped
                </>
              )}{" "}
              of {result.rowCount} rows.
            </p>
            {result.errors.length > 0 && (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-muted p-3 text-caption">
                {result.errors.map((e) => (
                  <p key={e.row}>
                    Row {e.row}: {e.error}
                  </p>
                ))}
              </div>
            )}
          </div>
        ) : !preview ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void choose(f);
              }}
            />
            <Upload className="size-6 text-muted-foreground" />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              Choose a CSV file
            </Button>
            <p className="text-caption text-muted-foreground">Phone numbers with a country code (+91…), or set the default below.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-caption text-muted-foreground">
              {file?.name} · {preview.rowCount.toLocaleString("en-IN")} rows · columns: {preview.headers.join(", ")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Phone number</Label>
                {columnSelect(mapping.phone, (v) => setMapping((m) => ({ ...m, phone: v })), "Phone column", true)}
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                {columnSelect(mapping.name, (v) => setMapping((m) => ({ ...m, name: v })), "Name column")}
              </div>
              <div className="space-y-1.5">
                <Label>Tags (comma or semicolon separated)</Label>
                {columnSelect(mapping.tags, (v) => setMapping((m) => ({ ...m, tags: v })), "Tags column")}
              </div>
              <div className="space-y-1.5">
                <Label>Consent (yes / no)</Label>
                {columnSelect(mapping.optIn, (v) => setMapping((m) => ({ ...m, optIn: v })), "Consent column")}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Attributes</Label>
              {attributes.map((a, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    className="h-8 w-40"
                    value={a.key}
                    onChange={(e) => setAttributes((list) => list.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase() } : x)))}
                    placeholder="attribute_name"
                    aria-label="Attribute name"
                  />
                  {columnSelect(a.column, (v) => setAttributes((list) => list.map((x, j) => (j === i ? { ...x, column: v } : x))), "Attribute column")}
                  <Button variant="ghost" size="icon-xs" onClick={() => setAttributes((list) => list.filter((_, j) => j !== i))} aria-label="Remove attribute">
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="xs" onClick={() => setAttributes((list) => [...list, { key: "", column: "" }])}>
                <Plus />
                Map a column to an attribute
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="imp-cc">Default country code</Label>
                <Input id="imp-cc" value={countryCode} onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="91" />
                <p className="text-micro text-muted-foreground">For numbers written without one. Leave empty to skip such rows.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="imp-tags">Tag everyone in this file</Label>
                <Input id="imp-tags" value={extraTags} onChange={(e) => setExtraTags(e.target.value)} placeholder="e.g. diwali-2026" />
              </div>
            </div>
            <label className="flex items-start gap-2 text-caption">
              <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} className="mt-0.5" />
              Everyone in this file agreed to receive WhatsApp messages from us. Records an opt-in for each (never for someone who opted out).
            </label>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button
              variant="accent"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              {preview && (
                <Button variant="ghost" onClick={reset}>
                  Choose another file
                </Button>
              )}
              <Button variant="accent" disabled={!preview || !mapping.phone || run.isPending} onClick={submit}>
                {run.isPending && <Loader2 className="animate-spin" />}
                Import {preview ? preview.rowCount.toLocaleString("en-IN") : ""} rows
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
