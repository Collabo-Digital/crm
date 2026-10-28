import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Building2,
  Eye,
  FileText,
  ImageIcon,
  Palette,
  Pipette,
  Plus,
  Printer,
  QrCode,
  Signature,
  Trash2,
} from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { ImageUpload } from "~/components/app/settings/image-upload";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  BRAND_COLOR_PRESETS,
  BUSINESS_ID_LABELS,
  MAX_BUSINESS_IDS,
  isLightBrandColor,
  type InvoiceDraft,
} from "~/lib/invoice-settings";
import { cn } from "~/lib/utils";
import type { BusinessId, BusinessIdType, ContactShown } from "~/types/api";

/** What every section is given: the unsaved form, a setter, the form's errors, and whether it may change. */
export interface SectionProps {
  draft: InvoiceDraft;
  set: <K extends keyof InvoiceDraft>(key: K, value: InvoiceDraft[K]) => void;
  errors: Record<string, string>;
  readOnly: boolean;
}

const selectClass = "h-8 w-full rounded-lg border border-input bg-background px-2 text-body disabled:opacity-50";

// ── Small pieces, the same shape as the point of sale settings' ─────────────

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-micro text-danger">{error}</p>
      ) : (
        hint && <p className="text-micro text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function SwitchRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-1 text-micro text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; title: string; hint: string }>;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 px-5 py-4">
      <p className="text-label">{label}</p>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed",
              value === o.value ? "border-foreground bg-muted/60 ring-1 ring-foreground" : "enabled:hover:bg-muted/40",
            )}
          >
            <span className="block text-label">{o.title}</span>
            <span className="block text-micro text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const CONTACT_OPTIONS: ReadonlyArray<{ value: ContactShown; title: string; hint: string }> = [
  { value: "hide", title: "Hide", hint: "Not printed. GST doesn't ask for it." },
  { value: "mask", title: "Mask", hint: "Like +91 98XXXXXX10." },
  { value: "show", title: "Show", hint: "In full." },
];

// ── 2. Look ─────────────────────────────────────────────────────────────────

/**
 * A thumbnail of a theme: a header, a table of four items and the total.
 * Paper, so literal white and greys, with the brand colour as a computed style.
 */
function ThemeSketch({ theme, color }: { theme: "modern" | "classic"; color: string | null }) {
  const classic = theme === "classic";
  const ink = "#111827";
  const accent = color ?? ink;
  const tint = color ? `color-mix(in srgb, ${color} 14%, white)` : "#F3F4F6";
  // A light colour never colours text on the PDF, so the title stays ink too.
  const title = !classic && color && !isLightBrandColor(color) ? color : ink;
  const bar = (width: string, className = "bg-gray-300") => <span className={cn("block h-1 rounded-full", className)} style={{ width }} />;
  const rule = classic ? "border-gray-300" : "border-gray-100";
  return (
    <span className="block h-28 overflow-hidden rounded-md border border-gray-200 bg-white">
      {!classic && <span className="block h-1" style={{ backgroundColor: accent }} />}
      <span className={cn("block px-2.5", classic ? "pt-2.5" : "pt-1.5")}>
        <span className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1">
            {!classic && <span className="block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />}
            {bar("2.25rem", "bg-gray-700")}
          </span>
          <span className="block h-1.5 w-9 rounded-full" style={{ backgroundColor: title }} />
        </span>
        <span className="mt-1 block space-y-1">
          {bar("3.5rem")}
          {bar("2.5rem")}
        </span>
        <span className={cn("mt-2 block", classic && "border border-gray-300")}>
          <span
            className={cn("grid grid-cols-[3fr_1fr_1fr_1.5fr] border-b", classic ? "border-gray-300 bg-gray-100" : "")}
            style={classic ? undefined : { backgroundColor: tint, borderColor: accent }}
          >
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={cn("h-2", classic && i > 0 && "border-l border-gray-300")} />
            ))}
          </span>
          {[0, 1, 2, 3].map((row) => (
            <span key={row} className={cn("grid grid-cols-[3fr_1fr_1fr_1.5fr] border-b last:border-b-0", rule)}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={cn("flex h-2.5 items-center px-0.5", classic && i > 0 && "border-l border-gray-300", i > 0 && "justify-end")}>
                  <span className="block h-0.5 rounded-full bg-gray-300" style={{ width: i === 0 ? `${70 - row * 10}%` : "70%" }} />
                </span>
              ))}
            </span>
          ))}
        </span>
        <span
          className={cn("mt-1.5 ml-auto block h-2.5 w-2/5", classic ? "border border-gray-300 bg-gray-100" : "rounded-sm")}
          style={classic ? undefined : { backgroundColor: tint }}
        />
      </span>
    </span>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function LookSection({ draft, set, errors, readOnly }: SectionProps) {
  const [hexTouched, setHexTouched] = useState(false);
  const color = draft.brandColor && HEX.test(draft.brandColor.trim()) ? draft.brandColor.trim().toUpperCase() : null;
  const custom = !!color && !BRAND_COLOR_PRESETS.some((preset) => preset.hex === color);
  const themes = [
    { value: "modern" as const, title: "Modern", hint: "Clean, with your brand colour. Good for online orders and WhatsApp." },
    { value: "classic" as const, title: "Classic", hint: "A ruled grid in black and white, the way accountants expect." },
  ];
  return (
    <SectionCard title="Look" icon={<Palette className="size-4 text-muted-foreground" />} description="For invoices, credit notes and bills. Till receipts print in black and white.">
      <div id="invoice-look" className="divide-y">
        <div className="space-y-2 px-5 py-4">
          <p className="text-label">Theme</p>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Theme">
            {themes.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={draft.theme === t.value}
                disabled={readOnly}
                onClick={() => set("theme", t.value)}
                className={cn(
                  "rounded-xl border p-2 text-left transition-colors disabled:cursor-not-allowed",
                  draft.theme === t.value ? "border-foreground ring-1 ring-foreground" : "enabled:hover:bg-muted/40",
                )}
              >
                <ThemeSketch theme={t.value} color={color} />
                <span className="mt-2 block px-1 text-label">{t.title}</span>
                <span className="block px-1 pb-1 text-micro text-muted-foreground">{t.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <SwitchRow
          id="invoice-classic-b2b"
          label="Use Classic for business invoices"
          hint="Invoices to GST-registered buyers print in Classic, whichever theme you pick."
          checked={draft.classicForB2b}
          onChange={(v) => set("classicForB2b", v)}
          disabled={readOnly}
        />

        <div className="space-y-3 px-5 py-4">
          <div>
            <p className="text-label">Brand colour</p>
            <p className="mt-1 text-micro text-muted-foreground">Colours the top bar, the title and the table shading in the Modern theme.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Brand colour">
            <button
              type="button"
              role="radio"
              aria-checked={draft.brandColor === null}
              aria-label="No colour"
              title="No colour"
              disabled={readOnly}
              onClick={() => set("brandColor", null)}
              className={cn(
                "relative grid size-11 place-items-center overflow-hidden rounded-full border bg-card md:size-8",
                draft.brandColor === null && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
              )}
            >
              <span className="absolute h-px w-full rotate-45 bg-muted-foreground" />
            </button>
            {BRAND_COLOR_PRESETS.map(({ name, hex }) => (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={color === hex}
                aria-label={name}
                title={`${name} ${hex}`}
                disabled={readOnly}
                onClick={() => set("brandColor", hex)}
                className={cn("size-11 rounded-full md:size-8", color === hex && "ring-2 ring-foreground ring-offset-2 ring-offset-card")}
                style={{ backgroundColor: hex }}
              />
            ))}
            <label
              className={cn(
                "relative grid size-11 cursor-pointer place-items-center rounded-full border bg-muted text-muted-foreground md:size-8",
                custom && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                readOnly && "pointer-events-none opacity-50",
              )}
              title="Any colour"
              style={custom ? { backgroundColor: color } : undefined}
            >
              {!custom && <Pipette className="size-4" />}
              <span className="sr-only">Any colour</span>
              <input
                type="color"
                value={color ?? "#0F766E"}
                disabled={readOnly}
                onChange={(e) => set("brandColor", e.target.value.toUpperCase())}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>
            <Input
              id="invoice-brand-hex"
              aria-label="Brand colour code"
              value={draft.brandColor ?? ""}
              maxLength={7}
              placeholder="#0F766E"
              disabled={readOnly}
              aria-invalid={(hexTouched && !!errors.brandColor) || undefined}
              aria-describedby={hexTouched && errors.brandColor ? "invoice-brand-hex-error" : undefined}
              onBlur={() => setHexTouched(true)}
              onChange={(e) => set("brandColor", e.target.value.trim() === "" ? null : e.target.value)}
              className="w-28 font-mono uppercase"
            />
          </div>
          {hexTouched && errors.brandColor ? (
            <p id="invoice-brand-hex-error" className="text-micro text-danger">{errors.brandColor}</p>
          ) : (
            color &&
            isLightBrandColor(color) && (
              <p className="flex items-start gap-1.5 text-micro text-warning-strong">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                This colour is light, so text stays black. It colours the top bar and the shading only.
              </p>
            )
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ── 3. Logo ─────────────────────────────────────────────────────────────────

/** The logo upload. It lives on Store profile, the one place the logo is set. */
export function LogoSection({
  logoUrl,
  uploaded,
  readOnly,
  busy,
  onUpload,
  onRemove,
}: {
  logoUrl: string;
  /** False for a logo saved earlier as a web link: PDFs print only an uploaded file. */
  uploaded: boolean;
  readOnly: boolean;
  busy: "uploading" | "removing" | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <SectionCard title="Logo" icon={<ImageIcon className="size-4 text-muted-foreground" />}>
      <div className="space-y-3 p-5">
        <ImageUpload
          id="store-logo-file"
          noun="logo"
          imageUrl={logoUrl || null}
          maxBytes={1024 * 1024}
          minWidth={300}
          hint="PNG or JPG, at least 300 px wide, up to 1 MB. Printed on invoices, receipts and packing slips."
          readOnly={readOnly}
          busy={busy}
          onUpload={onUpload}
          onRemove={onRemove}
        />
        {logoUrl && !uploaded && (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-warning-text">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            This logo was saved as a web link. Invoices can only print an uploaded file, so they show your store
            name until you upload it here.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

/** The logo as invoices print it, set on Store profile. */
export function LogoFromStoreProfile({ logoUrl, uploaded }: { logoUrl: string; uploaded: boolean }) {
  const [broken, setBroken] = useState(false);
  const shown = uploaded && logoUrl && !broken;
  return (
    <SectionCard
      title="Logo"
      icon={<ImageIcon className="size-4 text-muted-foreground" />}
      description="Your one logo, set in Store profile. Printed on invoices, receipts and packing slips."
    >
      <div className="flex flex-wrap items-center gap-3 p-5">
        <div className="grid h-16 w-40 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted/40">
          {shown ? (
            <img src={logoUrl} alt="Your logo" className="max-h-14 max-w-36 object-contain" onError={() => setBroken(true)} />
          ) : (
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <ImageIcon className="size-4" />
              {logoUrl && !uploaded ? "Not on invoices yet" : "No logo yet"}
            </span>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/store-profile#store-logo">{shown ? "Change in Store profile" : "Upload in Store profile"}</Link>
        </Button>
      </div>
    </SectionCard>
  );
}

// ── 4. Business details ─────────────────────────────────────────────────────

const ID_TYPES = Object.keys(BUSINESS_ID_LABELS) as BusinessIdType[];

function BusinessIdRow({
  index,
  id,
  errors,
  readOnly,
  autoFocus,
  touched,
  onTouched,
  onChange,
  onRemove,
}: {
  index: number;
  id: BusinessId;
  errors: Record<string, string>;
  readOnly: boolean;
  autoFocus: boolean;
  /** Left once: a row being filled in is not wrong yet. */
  touched: boolean;
  onTouched: () => void;
  onChange: (next: BusinessId) => void;
  onRemove: () => void;
}) {
  const custom = id.type === "CUSTOM";
  const problem = touched ? (errors[`businessIds.${index}.label`] ?? errors[`businessIds.${index}.value`]) : undefined;
  const n = index + 1;
  return (
    <div className="space-y-2 rounded-lg border p-3" onBlur={onTouched}>
      <div className="flex items-center gap-2">
        <select
          aria-label={`ID ${n} type`}
          value={id.type}
          disabled={readOnly}
          onChange={(e) => {
            const type = e.target.value as BusinessIdType;
            onChange({ ...id, type, label: type === "CUSTOM" ? id.label : "" });
          }}
          className={cn(selectClass, "flex-1 sm:max-w-48")}
        >
          {ID_TYPES.map((t) => (
            <option key={t} value={t}>
              {BUSINESS_ID_LABELS[t]}
            </option>
          ))}
        </select>
        {!readOnly && (
          <Button type="button" variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" onClick={onRemove} aria-label={`Remove ID ${n}`}>
            <Trash2 />
          </Button>
        )}
      </div>
      <div className={cn("grid gap-2", custom && "sm:grid-cols-2")}>
        {custom && (
          <Input
            aria-label={`ID ${n} name`}
            value={id.label}
            maxLength={24}
            placeholder="Name, like BIS Reg. No."
            disabled={readOnly}
            aria-invalid={(touched && !!errors[`businessIds.${index}.label`]) || undefined}
            aria-describedby={problem ? `invoice-business-id-${index}-error` : undefined}
            onChange={(e) => onChange({ ...id, label: e.target.value })}
          />
        )}
        <Input
          aria-label={`ID ${n} number`}
          value={id.value}
          maxLength={40}
          placeholder="Number"
          autoFocus={autoFocus}
          disabled={readOnly}
          aria-invalid={(touched && !!errors[`businessIds.${index}.value`]) || undefined}
          aria-describedby={problem ? `invoice-business-id-${index}-error` : undefined}
          onChange={(e) => onChange({ ...id, value: e.target.value })}
          className="font-mono"
        />
      </div>
      {problem && <p id={`invoice-business-id-${index}-error`} className="text-micro text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <label className="flex min-h-8 items-center gap-2 text-caption">
          <Checkbox checked={id.onA4} disabled={readOnly} onCheckedChange={(v) => onChange({ ...id, onA4: v === true })} />
          On invoices
        </label>
        <label className="flex min-h-8 items-center gap-2 text-caption">
          <Checkbox checked={id.onReceipt} disabled={readOnly} onCheckedChange={(v) => onChange({ ...id, onReceipt: v === true })} />
          On receipts
        </label>
      </div>
    </div>
  );
}

export function BusinessSection({ draft, set, errors, readOnly, pan }: SectionProps & { pan: string | null }) {
  const [added, setAdded] = useState<number | null>(null);
  // Rows the user has left, by position, which shifts when a row above is removed.
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const ids = draft.businessIds;
  const replace = (index: number, next: BusinessId | null) =>
    set("businessIds", next ? ids.map((id, i) => (i === index ? next : id)) : ids.filter((_, i) => i !== index));
  function remove(index: number) {
    setAdded(null);
    setTouched((prev) => new Set([...prev].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i))));
    replace(index, null);
  }
  function add() {
    const used = new Set(ids.map((id) => id.type));
    const type = ID_TYPES.find((t) => t !== "CUSTOM" && !used.has(t)) ?? "CUSTOM";
    setAdded(ids.length);
    set("businessIds", [...ids, { type, label: "", value: "", onA4: true, onReceipt: false }]);
  }
  return (
    <SectionCard title="Business details" icon={<Building2 className="size-4 text-muted-foreground" />} description="Printed with your GSTIN at the top of each invoice.">
      <div id="invoice-business" className="divide-y">
        <SwitchRow
          id="invoice-show-pan"
          label="Show PAN"
          hint={pan ? `PAN ${pan}, read from your GSTIN.` : "Your PAN is read from your GSTIN. Add a GSTIN in Tax & GST to print it."}
          checked={draft.showPan}
          onChange={(v) => set("showPan", v)}
          disabled={readOnly}
        />
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-label">Business IDs</p>
            <span className="text-micro text-muted-foreground">
              {ids.length} of {MAX_BUSINESS_IDS}
            </span>
          </div>
          <p className="text-micro text-muted-foreground">
            Like your FSSAI licence if you sell food, or your CIN if you're a company. Choose where each one prints.
          </p>
          {ids.map((id, i) => (
            <BusinessIdRow
              key={i}
              index={i}
              id={id}
              errors={errors}
              readOnly={readOnly}
              autoFocus={added === i}
              touched={touched.has(i)}
              onTouched={() => setTouched((prev) => (prev.has(i) ? prev : new Set(prev).add(i)))}
              onChange={(next) => replace(i, next)}
              onRemove={() => remove(i)}
            />
          ))}
          {!readOnly && ids.length < MAX_BUSINESS_IDS && (
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <Plus />
              Add an ID
            </Button>
          )}
        </div>
        <div className="px-5 py-4">
          <Field id="invoice-registered-office" label="Registered office" hint="Companies print their registered office address at the foot of each invoice.">
            <Input
              id="invoice-registered-office"
              value={draft.registeredOffice}
              maxLength={200}
              placeholder="No. 12, 100 Feet Road, Indiranagar, Bengaluru 560038"
              disabled={readOnly}
              onChange={(e) => set("registeredOffice", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </SectionCard>
  );
}

// ── 5. Terms and returns ────────────────────────────────────────────────────

export function TermsSection({ draft, set, errors, readOnly }: SectionProps) {
  const [linkTouched, setLinkTouched] = useState(false);
  return (
    <SectionCard title="Terms and returns" icon={<FileText className="size-4 text-muted-foreground" />}>
      <div id="invoice-terms" className="grid gap-4 p-5">
        <Field id="invoice-terms-text" label="Terms" hint="One per line. They print numbered.">
          <Textarea
            id="invoice-terms-text"
            rows={3}
            maxLength={1000}
            value={draft.terms}
            placeholder={"Goods once sold can be exchanged within 15 days.\nSubject to Bengaluru jurisdiction."}
            disabled={readOnly}
            onChange={(e) => set("terms", e.target.value)}
          />
        </Field>
        <Field id="invoice-return-policy" label="Return policy" hint="Printed on invoices and till receipts.">
          <Textarea
            id="invoice-return-policy"
            rows={2}
            maxLength={300}
            value={draft.returnPolicy}
            placeholder="Exchange within 15 days with this bill and tags. No cash refunds."
            disabled={readOnly}
            onChange={(e) => set("returnPolicy", e.target.value)}
          />
        </Field>
        <Field
          id="invoice-return-link"
          label="Return policy link"
          hint="A page with your full policy, printed after it."
          error={linkTouched ? errors.returnPolicyUrl : undefined}
        >
          <Input
            id="invoice-return-link"
            type="url"
            inputMode="url"
            value={draft.returnPolicyUrl}
            maxLength={300}
            placeholder="https://yourstore.com/returns"
            disabled={readOnly}
            aria-invalid={(linkTouched && !!errors.returnPolicyUrl) || undefined}
            aria-describedby={linkTouched && errors.returnPolicyUrl ? "invoice-return-link-error" : undefined}
            onBlur={() => setLinkTouched(true)}
            onChange={(e) => set("returnPolicyUrl", e.target.value)}
          />
        </Field>
        <Field id="invoice-footer-note" label="Footer note" hint="A line at the bottom of every invoice.">
          <Input
            id="invoice-footer-note"
            value={draft.footerNote}
            maxLength={150}
            placeholder="Thank you for shopping with us."
            disabled={readOnly}
            onChange={(e) => set("footerNote", e.target.value)}
          />
        </Field>
      </div>
    </SectionCard>
  );
}

// ── 6. Signature ────────────────────────────────────────────────────────────

export function SignatureSection({
  draft,
  set,
  readOnly,
  signatureUrl,
  busy,
  onUpload,
  onRemove,
}: SectionProps & {
  signatureUrl: string | null;
  busy: "uploading" | "removing" | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <SectionCard title="Signature" icon={<Signature className="size-4 text-muted-foreground" />}>
      <div id="invoice-signature" className="divide-y">
        <Choices
          label="On tax invoices and bills of supply"
          value={draft.signatureMode}
          disabled={readOnly}
          onChange={(v) => set("signatureMode", v)}
          options={[
            { value: "computer", title: "Computer-generated note", hint: "A line saying the invoice is computer-made and needs no signature." },
            { value: "image", title: "Signature image", hint: "Your uploaded signature, above the signatory's name." },
            { value: "blank", title: "Space to sign", hint: "A blank space for a signature by hand." },
          ]}
        />
        <div className="space-y-4 px-5 py-4">
          <p className="rounded-lg bg-muted px-3 py-2 text-caption text-muted-foreground">
            Credit notes always carry a signatory block, whichever you pick. If you take returns, upload a signature.
          </p>
          <ImageUpload
            id="invoice-signature-file"
            noun="signature"
            imageUrl={signatureUrl}
            maxBytes={300 * 1024}
            hint="PNG or JPG, up to 300 KB. A signature on a transparent background looks best."
            readOnly={readOnly}
            busy={busy}
            onUpload={onUpload}
            onRemove={onRemove}
          />
          {draft.signatureMode === "image" && !signatureUrl && (
            <p className="flex items-start gap-1.5 text-micro text-warning-strong">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              Upload a signature, or invoices leave a space to sign instead.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="invoice-signatory-name" label="Signatory's name">
              <Input
                id="invoice-signatory-name"
                value={draft.signatoryName}
                maxLength={60}
                placeholder="Meera Rao"
                disabled={readOnly}
                onChange={(e) => set("signatoryName", e.target.value)}
              />
            </Field>
            <Field id="invoice-signatory-designation" label="Designation">
              <Input
                id="invoice-signatory-designation"
                value={draft.signatoryDesignation}
                maxLength={60}
                placeholder="Director"
                disabled={readOnly}
                onChange={(e) => set("signatoryDesignation", e.target.value)}
              />
            </Field>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ── 7. What to show ─────────────────────────────────────────────────────────

export function ShowSection({ draft, set, readOnly }: SectionProps) {
  return (
    <SectionCard title="What to show" icon={<Eye className="size-4 text-muted-foreground" />} description="GST's own details, like HSN codes and tax rates, always print.">
      <div id="invoice-show" className="divide-y">
        <SwitchRow id="invoice-show-sku" label="SKU under each item" hint="Helps with returns and customer service." checked={draft.showSku} onChange={(v) => set("showSku", v)} disabled={readOnly} />
        <SwitchRow
          id="invoice-amount-words"
          label="Amount in words"
          hint="Like Rupees Five Thousand Six Hundred Forty-Seven Only."
          checked={draft.amountInWords}
          onChange={(v) => set("amountInWords", v)}
          disabled={readOnly}
        />
        <SwitchRow
          id="invoice-support-contact"
          label="Your support contacts"
          hint="The phone, WhatsApp and email from Store profile, at the top and foot of each invoice."
          checked={draft.showSupportContact}
          onChange={(v) => set("showSupportContact", v)}
          disabled={readOnly}
        />
        <Choices
          label="Tax summary by HSN"
          value={draft.taxSummary}
          disabled={readOnly}
          onChange={(v) => set("taxSummary", v)}
          options={[
            { value: "auto", title: "When needed", hint: "When an invoice has more than one HSN code or rate." },
            { value: "always", title: "Always", hint: "On every invoice." },
            { value: "never", title: "Never", hint: "Invoices to businesses still carry it." },
          ]}
        />
        <Choices
          label="Customer's phone and email"
          value={draft.customerContact}
          disabled={readOnly}
          onChange={(v) => set("customerContact", v)}
          options={CONTACT_OPTIONS}
        />
      </div>
    </SectionCard>
  );
}

// ── 8. Payments ─────────────────────────────────────────────────────────────

export function PaymentsSection({
  draft,
  set,
  readOnly,
  upiId,
  upiError,
  onUpiId,
}: SectionProps & {
  /** Null when this member can't see the till's settings. */
  upiId: string | null;
  upiError: string | null;
  onUpiId: (value: string) => void;
}) {
  return (
    <SectionCard title="Payments" icon={<QrCode className="size-4 text-muted-foreground" />}>
      <div id="invoice-payments" className="divide-y">
        <SwitchRow
          id="invoice-upi-qr"
          label="UPI QR on unpaid invoices"
          hint="A QR for the balance, so customers can pay from any UPI app. Never on cash-on-delivery orders."
          checked={draft.upiQr === "unpaid"}
          onChange={(v) => set("upiQr", v ? "unpaid" : "never")}
          disabled={readOnly}
        />
        {upiId !== null && (
          <div className="px-5 py-4">
            <Field
              id="invoice-upi"
              label="UPI ID"
              error={upiError ?? undefined}
              hint={draft.upiQr === "unpaid" && !upiId.trim() ? "Add a UPI ID for the QR to print. The till uses it too." : "The till uses it too."}
            >
              <Input
                id="invoice-upi"
                value={upiId}
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                placeholder="yourshop@okaxis"
                disabled={readOnly}
                aria-invalid={!!upiError || undefined}
                aria-describedby={upiError ? "invoice-upi-error" : undefined}
                onChange={(e) => onUpiId(e.target.value)}
                className="sm:max-w-sm"
              />
            </Field>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── 9. Receipt ──────────────────────────────────────────────────────────────

export function ReceiptSection({ draft, set, readOnly }: SectionProps) {
  return (
    <SectionCard title="Till receipt" icon={<Printer className="size-4 text-muted-foreground" />}>
      <div id="invoice-receipt" className="divide-y">
        <Choices
          label="QR code"
          value={draft.receiptQr}
          disabled={readOnly}
          onChange={(v) => set("receiptQr", v)}
          options={[
            { value: "ebill", title: "E-bill link", hint: "Opens the bill on the customer's phone, for returns." },
            { value: "upi-when-due", title: "UPI while money is due", hint: "A UPI QR for the balance; the e-bill link once paid." },
            { value: "off", title: "None", hint: "No QR code." },
          ]}
        />
        <Choices label="Customer's phone" value={draft.receiptCustomerContact} disabled={readOnly} onChange={(v) => set("receiptCustomerContact", v)} options={CONTACT_OPTIONS} />
        <p className="px-5 py-4 text-micro text-muted-foreground">
          Paper width and the receipt's footer are in{" "}
          <Link to="/orders/pos/settings" className="font-medium text-foreground underline underline-offset-2">
            Point of sale settings
          </Link>
          .
        </p>
      </div>
    </SectionCard>
  );
}
