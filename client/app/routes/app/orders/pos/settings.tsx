import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock, ImageIcon, LayoutGrid, Loader2, Lock, MessageCircle, Plus, Printer, ReceiptIndianRupee, Search, ShieldCheck, Users, Wallet, X } from "lucide-react";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useDebounced } from "~/hooks/use-debounced";
import { useCreatePosStaffMutation, useUpdatePosSettingsMutation, useUpdatePosStaffMutation } from "~/hooks/use-pos-mutations";
import { usePosProducts, usePosSetup, usePosStaff } from "~/hooks/use-pos-queries";
import { serverMessage } from "~/lib/handle-mutation-error";
import { UPI_ID } from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosProduct, PosSettings, PosSetup, PosStaffRole, PosStaffView } from "~/types/api";

export function meta() {
  return [{ title: "Point of sale settings | Collabo CRM" }];
}

const PIN = /^\d{4,6}$/;
const selectClass = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";

interface Form {
  upiId: string;
  upiPayeeName: string;
  roundOff: boolean;
  requireStaffPin: boolean;
  discountApprovalPercent: string;
  priceOverrideNeedsApproval: boolean;
  receiptWidth: 58 | 80;
  receiptFooter: string;
  tileVariantIds: string[];
  customerAtCheckout: PosSettings["customerAtCheckout"];
  customerRequiredAbove: string;
  autoSendBill: boolean;
}

function toForm(s: PosSettings): Form {
  return {
    upiId: s.upiId ?? "",
    upiPayeeName: s.upiPayeeName ?? "",
    roundOff: s.roundOff,
    requireStaffPin: s.requireStaffPin,
    discountApprovalPercent: s.discountApprovalPercent == null ? "" : String(s.discountApprovalPercent),
    priceOverrideNeedsApproval: s.priceOverrideNeedsApproval,
    receiptWidth: s.receiptWidth,
    receiptFooter: s.receiptFooter ?? "",
    tileVariantIds: s.tileVariantIds,
    customerAtCheckout: s.customerAtCheckout,
    customerRequiredAbove: s.customerRequiredAbove == null ? "" : String(s.customerRequiredAbove),
    autoSendBill: s.autoSendBill,
  };
}

function toSettings(f: Form): PosSettings {
  return {
    upiId: f.upiId.trim() || null,
    upiPayeeName: f.upiPayeeName.trim() || null,
    roundOff: f.roundOff,
    requireStaffPin: f.requireStaffPin,
    discountApprovalPercent: f.discountApprovalPercent.trim() === "" ? null : Number(f.discountApprovalPercent),
    priceOverrideNeedsApproval: f.priceOverrideNeedsApproval,
    receiptWidth: f.receiptWidth,
    receiptFooter: f.receiptFooter.trim() || null,
    tileVariantIds: f.tileVariantIds,
    customerAtCheckout: f.customerAtCheckout,
    customerRequiredAbove: f.customerRequiredAbove.trim() === "" ? null : Number(f.customerRequiredAbove),
    autoSendBill: f.autoSendBill,
  };
}

/** Only what changed, so two managers saving different fields don't undo each other. */
function changes(before: PosSettings, after: PosSettings): Partial<PosSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as Array<keyof PosSettings>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out as Partial<PosSettings>;
}

/**
 * Orders → Point of sale → Settings: UPI, billing rules, approvals, receipt,
 * quick tiles and the staff who unlock the till. Owners, admins and managers.
 */
export default function PosSettingsPage() {
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const setup = usePosSetup(undefined, canManage);
  const save = useUpdatePosSettingsMutation();
  const [form, setForm] = useState<Form | null>(null);
  const [tileInfo, setTileInfo] = useState<Map<string, PosProduct>>(new Map());

  useEffect(() => {
    if (!setup.data || form) return;
    setForm(toForm(setup.data.settings));
    setTileInfo(new Map(setup.data.tiles.map((t) => [t.variantId, t])));
  }, [setup.data, form]);

  if (!canManage) {
    return (
      <div className="py-16">
        <EmptyState
          icon={Lock}
          title="Only owners, admins and managers can change point of sale settings"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/orders/pos">Back to the till</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const settings = setup.data?.settings;
  const next = form && toSettings(form);
  const diff = settings && next ? changes(settings, next) : {};
  const dirty = Object.keys(diff).length > 0;
  const upiInvalid = !!form?.upiId.trim() && !UPI_ID.test(form.upiId.trim());
  const limit = Number(form?.discountApprovalPercent);
  const limitInvalid = !!form?.discountApprovalPercent.trim() && (!Number.isFinite(limit) || limit < 0 || limit > 100);
  const above = Number(form?.customerRequiredAbove);
  const aboveInvalid = !!form?.customerRequiredAbove.trim() && (!Number.isInteger(above) || above < 1);
  const canSave = dirty && !upiInvalid && !limitInvalid && !aboveInvalid && !save.isPending;
  const patch = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));

  const saveButton = (
    <Button type="submit" form="pos-settings" variant="accent" disabled={!canSave}>
      {save.isPending && <Loader2 className="animate-spin" />}
      Save changes
    </Button>
  );

  return (
    <div className="settings-page mx-auto max-w-3xl space-y-6">
      <PageHeader data-mobile-title>
        <PageHeaderContent>
          <Link to="/orders/pos" className="inline-flex min-h-9 items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            Back to the till
          </Link>
          <PageHeaderTitle>Point of sale settings</PageHeaderTitle>
          <PageHeaderDescription>How the till takes payment, who can unlock it, and what the receipt says.</PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="max-md:hidden">{saveButton}</PageHeaderActions>
      </PageHeader>

      {setup.isLoading || (setup.data && !form) ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      ) : !form || !settings ? (
        <QueryErrorState resource="the point of sale settings" onRetry={() => void setup.refetch()} />
      ) : (
        <>
          <form
            id="pos-settings"
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSave) return;
              save.mutate(diff, { onSuccess: (saved) => setForm(toForm(saved)) });
            }}
          >
            <SectionCard title="UPI payments" icon={<Wallet className="size-4 text-muted-foreground" />} description="The till shows a QR code for the exact bill amount, paid straight to this UPI ID.">
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Field id="pos-upi" label="UPI ID" hint={upiInvalid ? undefined : "Like yourshop@okaxis. Leave empty to record UPI payments without a QR code."}>
                  <Input id="pos-upi" value={form.upiId} maxLength={100} autoComplete="off" spellCheck={false} placeholder="yourshop@okaxis" aria-invalid={upiInvalid || undefined} onChange={(e) => patch({ upiId: e.target.value })} />
                  {upiInvalid && <p className="text-micro text-danger">A UPI ID looks like name@bank, with no spaces.</p>}
                </Field>
                <Field id="pos-payee" label="Payee name" hint="Customers see this name in their UPI app.">
                  <Input id="pos-payee" value={form.upiPayeeName} maxLength={60} placeholder={setup.data?.storeName} onChange={(e) => patch({ upiPayeeName: e.target.value })} />
                </Field>
              </div>
            </SectionCard>

            <SectionCard title="Billing" icon={<ReceiptIndianRupee className="size-4 text-muted-foreground" />}>
              <div className="divide-y">
                <Toggle id="pos-roundoff" label="Round off the payable" hint="Takes each bill to the nearest rupee, and shows the difference on the receipt." checked={form.roundOff} onChange={(v) => patch({ roundOff: v })} />
                <div className="space-y-2 px-5 py-4">
                  <p className="text-label">Customer at checkout</p>
                  <p className="text-micro text-muted-foreground">When the cashier taps Charge and no customer is on the bill yet.</p>
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Customer at checkout">
                    <Choice checked={form.customerAtCheckout === "off"} onSelect={() => patch({ customerAtCheckout: "off" })} title="Off" hint="Never asks. A customer can still be added from the cart." />
                    <Choice checked={form.customerAtCheckout === "ask"} onSelect={() => patch({ customerAtCheckout: "ask" })} title="Ask" hint="Asks for their mobile number, with Skip for walk-ins." />
                    <Choice checked={form.customerAtCheckout === "required"} onSelect={() => patch({ customerAtCheckout: "required" })} title="Required" hint="Every bill needs the customer's mobile number." />
                  </div>
                </div>
                <div className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_160px] sm:items-center">
                  <div>
                    <Label htmlFor="pos-above">Ask for name and address on bills of</Label>
                    <p className="mt-1 text-micro text-muted-foreground">
                      GST rules need the buyer's name and address from ₹50,000. Asked even when the till doesn't ask for the customer. Leave empty to never ask.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-caption text-muted-foreground">₹</span>
                      <Input id="pos-above" type="number" inputMode="numeric" min={1} step="1" value={form.customerRequiredAbove} placeholder="50000" aria-invalid={aboveInvalid || undefined} onChange={(e) => patch({ customerRequiredAbove: e.target.value })} className="pl-7 tabular-nums" />
                    </div>
                    {aboveInvalid && <p className="text-micro text-danger">Enter a whole amount in rupees.</p>}
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Bill on WhatsApp" icon={<MessageCircle className="size-4 text-muted-foreground" />} description="After a sale, the customer gets a link to their bill on WhatsApp.">
              <div className="divide-y">
                <Toggle id="pos-autosend" label="Send the bill on WhatsApp automatically" hint="To the mobile number on the bill, right after payment. Cashiers can always send or share it from the payment screen." checked={form.autoSendBill} onChange={(v) => patch({ autoSendBill: v })} />
                {setup.data && <WhatsAppBillStatus whatsapp={setup.data.billDelivery.whatsapp} />}
              </div>
            </SectionCard>

            <SectionCard title="Staff PINs and approvals" icon={<ShieldCheck className="size-4 text-muted-foreground" />}>
              <div className="divide-y">
                <Toggle id="pos-pin" label="Staff unlock the till with a PIN" hint="Each sale then records who billed it. The till locks when someone taps Lock." checked={form.requireStaffPin} onChange={(v) => patch({ requireStaffPin: v })} />
                <div className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_140px] sm:items-center">
                  <div>
                    <Label htmlFor="pos-limit">Discounts above this need a manager's PIN</Label>
                    <p className="mt-1 text-micro text-muted-foreground">As a share of the bill or of one item. Leave empty for no limit.</p>
                  </div>
                  <div className="space-y-1">
                    <div className="relative">
                      <Input id="pos-limit" type="number" inputMode="decimal" min={0} max={100} step="0.5" value={form.discountApprovalPercent} aria-invalid={limitInvalid || undefined} onChange={(e) => patch({ discountApprovalPercent: e.target.value })} className="pr-8 tabular-nums" />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-caption text-muted-foreground">%</span>
                    </div>
                    {limitInvalid && <p className="text-micro text-danger">Enter a number from 0 to 100.</p>}
                  </div>
                </div>
                <Toggle id="pos-price" label="Price changes need a manager's PIN" hint="When a cashier changes a product's price in the cart." checked={form.priceOverrideNeedsApproval} onChange={(v) => patch({ priceOverrideNeedsApproval: v })} />
              </div>
            </SectionCard>

            <SectionCard title="Receipt" icon={<Printer className="size-4 text-muted-foreground" />} description="Printed on a thermal receipt printer from the browser's print window.">
              <div className="space-y-4 p-5">
                <div className="space-y-2">
                  <p className="text-label">Paper width</p>
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Paper width">
                    <Choice checked={form.receiptWidth === 80} onSelect={() => patch({ receiptWidth: 80 })} title="80 mm" hint="The usual counter printer roll." />
                    <Choice checked={form.receiptWidth === 58} onSelect={() => patch({ receiptWidth: 58 })} title="58 mm" hint="Small and portable printers." />
                  </div>
                </div>
                <Field id="pos-footer" label="Footer" hint="Printed at the bottom of every receipt, for example your exchange policy.">
                  <Textarea id="pos-footer" rows={3} maxLength={300} value={form.receiptFooter} placeholder="Exchange within 7 days with this bill. No refunds on sale items." onChange={(e) => patch({ receiptFooter: e.target.value })} />
                </Field>
              </div>
            </SectionCard>

            <SectionCard title="Quick tiles" icon={<LayoutGrid className="size-4 text-muted-foreground" />} description="Products shown on the till before anything is searched, for one-tap billing.">
              <TilePicker
                ids={form.tileVariantIds}
                info={tileInfo}
                onAdd={(p) => {
                  setTileInfo((m) => new Map(m).set(p.variantId, p));
                  patch({ tileVariantIds: [...form.tileVariantIds, p.variantId] });
                }}
                onRemove={(id) => patch({ tileVariantIds: form.tileVariantIds.filter((t) => t !== id) })}
              />
            </SectionCard>

            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="text-caption text-muted-foreground">You have unsaved changes.</span>}
              {saveButton}
            </div>
          </form>

          <StaffSection requirePin={form.requireStaffPin} />
        </>
      )}
    </div>
  );
}

/** Whether bills can go out on WhatsApp: the connection, and the bill message template Meta must approve. */
function WhatsAppBillStatus({ whatsapp }: { whatsapp: PosSetup["billDelivery"]["whatsapp"] }) {
  const template = {
    approved: { icon: CheckCircle2, tone: "text-success", text: "Approved" },
    pending: { icon: Clock, tone: "text-warning-strong", text: "Waiting for Meta's approval" },
    missing: { icon: CircleAlert, tone: "text-danger", text: "Not set up" },
  }[whatsapp.template];
  const TemplateIcon = template.icon;
  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-label">WhatsApp bill</p>
      <dl className="grid gap-2 rounded-lg border p-3 text-caption sm:grid-cols-[max-content_1fr] sm:gap-x-6">
        <dt className="text-muted-foreground">WhatsApp</dt>
        <dd className={cn("flex items-center gap-1.5 font-medium", whatsapp.connected ? "text-success" : "text-danger")}>
          {whatsapp.connected ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
          {whatsapp.connected ? "Connected" : "Not connected"}
        </dd>
        <dt className="text-muted-foreground">Bill template</dt>
        <dd className={cn("flex flex-wrap items-center gap-1.5 font-medium", template.tone)}>
          <TemplateIcon className="size-3.5" />
          {template.text}
          {whatsapp.templateName && <span className="font-mono font-normal text-muted-foreground">{whatsapp.templateName}</span>}
        </dd>
      </dl>
      <p className="text-micro text-muted-foreground">
        {!whatsapp.connected
          ? "Until WhatsApp is connected, the payment screen says the bill wasn't sent, and cashiers can share the link instead. "
          : whatsapp.template === "pending"
            ? "Until Meta approves the bill template, the payment screen says the bill wasn't sent, and cashiers can share the link instead. "
            : whatsapp.template === "missing"
              ? "Until a bill template is set up and approved, the payment screen says the bill wasn't sent, and cashiers can share the link instead. "
              : "Bills go out with this template. "}
        {!whatsapp.connected && (
          <>
            <Link to="/settings/channels" className="font-medium text-foreground underline underline-offset-2">
              Connect WhatsApp
            </Link>
            {" · "}
          </>
        )}
        <Link to="/campaigns/templates" className="font-medium text-foreground underline underline-offset-2">
          Campaigns → Templates
        </Link>
      </p>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-1 text-micro text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

function Choice({ checked, onSelect, title, hint }: { checked: boolean; onSelect: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn("rounded-lg border px-3 py-2.5 text-left transition-colors", checked ? "border-foreground bg-muted/60 ring-1 ring-foreground" : "hover:bg-muted/40")}
    >
      <span className="block text-label">{title}</span>
      <span className="block text-micro text-muted-foreground">{hint}</span>
    </button>
  );
}

function TilePicker({ ids, info, onAdd, onRemove }: { ids: string[]; info: Map<string, PosProduct>; onAdd: (p: PosProduct) => void; onRemove: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const results = usePosProducts(debounced);
  const picked = useMemo(() => new Set(ids), [ids]);
  const matches = (debounced.trim() ? (results.data ?? []) : []).filter((p) => !picked.has(p.variantId));

  return (
    <div className="space-y-4 p-5">
      {ids.length === 0 ? (
        <p className="text-caption text-muted-foreground">No quick tiles yet. Search below to add your best sellers.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {ids.map((id) => {
            const p = info.get(id);
            return (
              <li key={id} className="flex items-center gap-3 rounded-lg border p-2">
                <TileThumb product={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label">{p?.title ?? "A product that is no longer sold"}</span>
                  <span className="block truncate text-micro text-muted-foreground">{p ? [p.variantTitle, formatCurrency(p.price, "INR")].filter(Boolean).join(" · ") : id}</span>
                </span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${p?.title ?? "this tile"}`} onClick={() => onRemove(id)}>
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products to add as tiles" aria-label="Search products to add as tiles" className="pl-8" />
        </div>
        {debounced.trim() && (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {results.isFetching && matches.length === 0 ? (
              <li className="px-3 py-2 text-caption text-muted-foreground">Searching…</li>
            ) : matches.length === 0 ? (
              <li className="px-3 py-2 text-caption text-muted-foreground">No more products match “{debounced.trim()}”.</li>
            ) : (
              matches.map((p) => (
                <li key={p.variantId}>
                  <button type="button" onClick={() => onAdd(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted">
                    <TileThumb product={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-label">{p.title}</span>
                      <span className="block truncate text-micro text-muted-foreground">{[p.variantTitle, p.sku, formatCurrency(p.price, "INR")].filter(Boolean).join(" · ")}</span>
                    </span>
                    <Plus className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function TileThumb({ product }: { product?: PosProduct }) {
  return product?.imageUrl ? (
    <img src={product.imageUrl} alt="" className="size-10 shrink-0 rounded-md bg-muted object-cover" />
  ) : (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <ImageIcon className="size-4" />
    </span>
  );
}

const ROLE_LABEL: Record<PosStaffRole, string> = { CASHIER: "Cashier", MANAGER: "Manager" };

function StaffSection({ requirePin }: { requirePin: boolean }) {
  const staff = usePosStaff();
  const create = useCreatePosStaffMutation();
  const [name, setName] = useState("");
  const [role, setRole] = useState<PosStaffRole>("CASHIER");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && PIN.test(pin);

  return (
    <SectionCard
      title="Staff"
      icon={<Users className="size-4 text-muted-foreground" />}
      description={
        requirePin
          ? "Each person unlocks the till with their own PIN. Managers also approve discounts and price changes."
          : "PINs say who billed a sale. Managers also approve discounts and price changes."
      }
    >
      <div className="space-y-4 p-5">
        {staff.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : staff.isError ? (
          <QueryErrorState resource="staff" onRetry={() => void staff.refetch()} />
        ) : !staff.data?.length ? (
          <p className="text-caption text-muted-foreground">No staff yet. Add the first person below.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {staff.data.map((s) => (
              <StaffRow key={s.id} staff={s} />
            ))}
          </ul>
        )}

        <form
          className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-[1fr_140px_120px_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setError(null);
            create.mutate(
              { name: name.trim(), role, pin },
              {
                onSuccess: () => {
                  setName("");
                  setPin("");
                  setRole("CASHIER");
                },
                onError: (err) => setError(serverMessage(err, "This person was not added.")),
              },
            );
          }}
        >
          <Field id="pos-staff-name" label="Name">
            <Input id="pos-staff-name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} placeholder="Anjali" />
          </Field>
          <Field id="pos-staff-role" label="Role">
            <select id="pos-staff-role" className={selectClass} value={role} onChange={(e) => setRole(e.target.value as PosStaffRole)}>
              <option value="CASHIER">Cashier</option>
              <option value="MANAGER">Manager</option>
            </select>
          </Field>
          <Field id="pos-staff-pin" label="PIN">
            <PinInput id="pos-staff-pin" value={pin} onChange={setPin} />
          </Field>
          <Button type="submit" variant="outline" disabled={!valid || create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add
          </Button>
          <p className={cn("text-micro sm:col-span-4", error ? "text-danger" : "text-muted-foreground")}>{error ?? "A PIN is 4 to 6 digits and must differ from everyone else's."}</p>
        </form>
      </div>
    </SectionCard>
  );
}

function PinInput({ id, value, onChange, label }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <Input
      id={id}
      aria-label={label}
      type="password"
      inputMode="numeric"
      autoComplete="new-password"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      className="tracking-[0.3em] tabular-nums"
    />
  );
}

function StaffRow({ staff }: { staff: PosStaffView }) {
  const update = useUpdatePosStaffMutation();
  const [changingPin, setChangingPin] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onError = (err: unknown) => setError(serverMessage(err, "The change was not saved."));

  return (
    <li className={cn("space-y-2 px-3 py-2.5", !staff.isActive && "bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-label">{staff.name.charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1 basis-32">
          <span className={cn("block truncate text-label", !staff.isActive && "text-muted-foreground")}>{staff.name}</span>
          <span className="block text-micro text-muted-foreground">
            {ROLE_LABEL[staff.role]}
            {!staff.isActive && " · Deactivated"}
          </span>
        </span>
        {staff.isActive && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setChangingPin(!changingPin)} aria-expanded={changingPin}>
            Change PIN
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={update.isPending}
          onClick={() => {
            if (staff.isActive && !window.confirm(`Deactivate ${staff.name}? Their PIN stops working at once.`)) return;
            setError(null);
            update.mutate({ id: staff.id, isActive: !staff.isActive }, { onError });
          }}
        >
          {staff.isActive ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
      {changingPin && (
        <form
          className="flex flex-wrap items-center gap-2 pl-10"
          onSubmit={(e) => {
            e.preventDefault();
            if (!PIN.test(pin)) return;
            setError(null);
            update.mutate(
              { id: staff.id, pin },
              {
                onSuccess: () => {
                  setPin("");
                  setChangingPin(false);
                },
                onError,
              },
            );
          }}
        >
          <div className="w-32">
            <PinInput id={`pos-pin-${staff.id}`} value={pin} onChange={setPin} label={`New PIN for ${staff.name}`} />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!PIN.test(pin) || update.isPending}>
            Save PIN
          </Button>
        </form>
      )}
      {error && <p className="pl-10 text-micro text-danger">{error}</p>}
    </li>
  );
}
