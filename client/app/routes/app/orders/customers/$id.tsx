import { useState } from "react";
import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { Link, useNavigate, useParams } from "react-router";
import { useStartChatMutation } from "~/hooks/use-inbox-mutations";
import { useSectionAccess } from "~/hooks/use-section-access";
import {
  ChevronLeft,
  ChevronRight,
  Link2,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Receipt,
  Unlink,
  X,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { SectionCard } from "~/components/app/section-card";
import { ChannelBadge } from "~/components/app/channel-badge";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { CustomerGstDialog } from "~/components/app/customer-gst-dialog";
import { CustomerOrdersPanel } from "~/components/app/customer-orders-panel";
import { NotYet } from "~/components/app/not-yet";
import { ContactSearchDialog, PlatformIcon, chatHandle } from "~/components/app/inbox/contact-search-dialog";
import { useCustomer } from "~/hooks/use-customer-queries";
import { useLinkChatMutation, useUnlinkChatMutation, useUpdateCustomerMutation } from "~/hooks/use-customer-mutations";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { VIP_CLASSES, VIP_LABELS } from "~/lib/customer-status";
import { formatDateTime } from "~/lib/inbox-format";
import { mapsEmbedUrl, mapsUrl, readAddress } from "~/lib/address";
import { cn, formatCurrency } from "~/lib/utils";
import type { CustomerDetail } from "~/types/api";

export function meta() {
  return [{ title: "Customer | Collabo CRM" }];
}

const TABS = [
  { id: "orders", label: "Purchase History" },
  // { id: "wishlist", label: "Wishlist" },
  { id: "loyalty", label: "Loyalty Program" },
  // { id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function getInitials(
  first: string | null | undefined,
  last: string | null | undefined,
) {
  const initials = `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
  return initials || "?";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const [activeTab, setActiveTab] = useSessionState<TabId>(
    "customer.tab",
    "orders",
    oneOf(TABS.map((tab) => tab.id)),
  );
  const [gstOpen, setGstOpen] = useState(false);

  const { data: customer, isLoading, isError, refetch } = useCustomer(id);
  const navigate = useNavigate();
  const startChat = useStartChatMutation();
  const { canAccess } = useSectionAccess();
  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !customer) {
    return (
      <div className="p-8">
        <QueryErrorState resource="this customer" onRetry={() => refetch()} />
      </div>
    );
  }

  const name =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    customer.email ||
    "—";
  const isActive = customer.state !== "DISABLED";
  // No numeric customer number exists — ids are cuids. Shopify's own id is the
  // closest thing to the mockup's "#56578"; the cuid tail is the fallback.
  const displayId = customer.externalId || customer.id.slice(-8);

  return (
    // `items-start` is load-bearing: without it the grid stretches both columns
    // to equal height and the sticky rail has nothing to scroll against.
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 space-y-5 lg:flex-2">
        {/* Header: identity + tabs */}
        <header className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border">
          <div className="flex flex-wrap justify-between gap-4">
            {/* <div className="flex flex-1 items-center gap-3"> */}

            {/* <Button asChild variant="outline" size="icon-sm">
                <Link to="/orders/customers" aria-label="Back to customers">
                  <ChevronLeft className="size-4" />
                </Link>
              </Button> */}

            <div className="flex min-w-0 gap-3">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand text-body font-semibold text-brand-foreground">
                {getInitials(customer.firstName, customer.lastName)}
              </span>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-subhead text-foreground">
                    {name}
                  </h1>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
                      isActive
                        ? "bg-brand/30 text-brand-strong"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isActive ? "Active" : "Disabled"}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
                      VIP_CLASSES[customer.vipLevel],
                    )}
                  >
                    {VIP_LABELS[customer.vipLevel]}
                  </span>
                </div>
                <p className="mt-0.5 text-caption text-muted-foreground">
                  Customer ID {displayId}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <DropdownMenu>
                {/* 38px is the measured height of a `size="action"` pill, so the
                    circle sits flush beside Send Message. The stock icon size
                    (32px) left it visibly short. */}
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9.5 rounded-full"
                    aria-label="Customer actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!gstEnabled}
                    onClick={() => setGstOpen(true)}
                  >
                    <Receipt className="mr-1.5 size-3.5" />
                    Edit GST details
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="brand"
                size="action"
                disabled={!customer.phone || !canAccess("/inbox") || startChat.isPending}
                title={!customer.phone ? "This customer has no phone number." : !canAccess("/inbox") ? "You do not have access to the inbox." : undefined}
                onClick={() =>
                  startChat.mutate(
                    { phone: customer.phone!, customerId: customer.id, name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || undefined },
                    { onSuccess: (r) => navigate(`/inbox?c=${r.conversationId}`) },
                  )
                }
              >
                Send Message
              </Button>

              {/* <NotYet title="Stepping between customers isn't available yet">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled
                  aria-label="Previous customer"
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </NotYet>
              <NotYet title="Stepping between customers isn't available yet">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled
                  aria-label="Next customer"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </NotYet> */}
            </div>
            {/* </div> */}
          </div>

          {/* Underline tabs. Every other tab bar in the app is a pill; this one
            follows the customer-detail design instead. */}
          <nav
            role="tablist"
            aria-label="Customer sections"
            className="-mb-5 mt-4 flex gap-6 overflow-x-auto border-b"
          >
            {TABS.map(({ id: tabId, label }) => (
              <button
                key={tabId}
                type="button"
                role="tab"
                id={`customer-tab-${tabId}`}
                aria-selected={activeTab === tabId}
                aria-controls="customer-tabpanel"
                onClick={() => setActiveTab(tabId)}
                className={cn(
                  "-mb-px shrink-0 border-b-2 px-1 py-3 text-body font-medium transition-colors",
                  activeTab === tabId
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        <div
          role="tabpanel"
          id="customer-tabpanel"
          aria-labelledby={`customer-tab-${activeTab}`}
        >
          {activeTab === "orders" && (
            <CustomerOrdersPanel
              customerId={customer.id}
              currency={orgCurrency}
            />
          )}
          {activeTab === "loyalty" && (
            <SectionCard
              title="Loyalty program"
              description="Tier history and rewards."
            >
              <div className="p-8">
                <EmptyState
                  title="Loyalty details aren't available yet"
                  description="VIP tier is shown beside the customer's name. Per-customer points and rewards don't exist in the platform yet."
                />
              </div>
            </SectionCard>
          )}
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:flex-1">
        {/* One card, internally divided — not four SectionCards. */}
        <div className="divide-y rounded-xl bg-card shadow-sm ring-1 ring-border">
          <CustomerDetailsSection customer={customer} currency={orgCurrency} />
          <ShippingAddressSection customer={customer} />
          <ContactSection customer={customer} />
          <TagsSection customer={customer} />
        </div>
        <ChatsCard customer={customer} />
      </aside>

      {gstOpen && (
        <CustomerGstDialog
          customerId={customer.id}
          customer={customer}
          onClose={() => setGstOpen(false)}
        />
      )}
    </div>
  );
}

// ── Rail sections ───────────────────────────────────────────────────────────

/**
 * A titled block inside the rail card.
 *
 * Deliberately not `SectionCard`: the design is a single card with hairline
 * dividers between sections, and `SectionCard` renders a whole card per call.
 * The parent supplies `divide-y`; this only owns its padding.
 */
function RailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-section text-foreground">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-caption text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Pencil affordance for a field the API cannot update. */
function DisabledPencil({ title }: { title: string }) {
  return (
    <NotYet title={title}>
      <Button variant="ghost" size="icon-xs" disabled aria-label={title}>
        <Pencil className="size-3.5" />
      </Button>
    </NotYet>
  );
}

function CustomerDetailsSection({
  customer,
  currency,
}: {
  customer: CustomerDetail;
  currency: string;
}) {
  // The Customer model has no last-seen column — only create/update timestamps —
  // so the newest order's date is the closest honest equivalent to the design's
  // "Last Online".
  const lastOrder = customer.orders?.[0]?.externalCreatedAt ?? null;

  return (
    <RailSection title="Customer Details">
      <div className="space-y-2.5">
        <RailRow label="Customer Source">
          <ChannelBadge
            variant="inline"
            platform={customer.channel?.platform}
            name={customer.channel?.name}
            className="text-caption font-medium text-brand-strong"
          />
        </RailRow>
        <RailRow label="Last order">
          <span className="text-caption text-foreground">
            {formatDate(lastOrder)}
          </span>
        </RailRow>
        <RailRow label="Lifetime spend">
          <span className="text-caption font-medium tabular-nums text-foreground">
            {formatCurrency(customer.totalSpent, currency)}
          </span>
        </RailRow>
      </div>
    </RailSection>
  );
}

function ShippingAddressSection({ customer }: { customer: CustomerDetail }) {
  const address = readAddress(
    customer.defaultAddress ?? customer.addresses?.[0],
  );
  const fallbackName = [customer.firstName, customer.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <RailSection
      title="Shipping Address"
      action={<DisabledPencil title="Editing addresses isn't supported yet" />}
    >
      {address.hasAddress ? (
        <>
          {/* The muted box sits behind the iframe, so a blank or throttled embed
              degrades to the old placeholder instead of a white hole. A
              cross-origin iframe fires no reliable load/error event, so this is
              the only fallback available to us. */}
          <div className="h-28 overflow-hidden rounded-lg bg-muted">
            <iframe
              src={mapsEmbedUrl(address.lines)}
              title={`Map of ${address.name || fallbackName || "the customer"}'s shipping address`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="size-full border-0"
            />
          </div>
          <div className="mt-3 flex items-baseline justify-between gap-3">
            <p className="truncate text-caption font-semibold text-foreground">
              {address.name || fallbackName || "—"}
            </p>
            <a
              href={mapsUrl(address.lines)}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-caption text-foreground underline underline-offset-2 hover:text-brand-strong"
            >
              View on Map
            </a>
          </div>
          <div className="mt-1.5 space-y-0.5">
            {address.lines.map((line) => (
              <p
                key={line}
                className="text-caption leading-snug text-muted-foreground"
              >
                {line}
              </p>
            ))}
          </div>
        </>
      ) : (
        <p className="text-caption text-muted-foreground">
          No address on file.
        </p>
      )}
    </RailSection>
  );
}

function ContactSection({ customer }: { customer: CustomerDetail }) {
  const chip =
    "inline-flex w-fit items-center rounded-full bg-brand/20 px-3 py-1 text-caption text-brand-strong hover:bg-brand/35";

  return (
    <RailSection
      title="Contact Information"
      action={
        <DisabledPencil title="Editing contact details isn't supported yet" />
      }
    >
      {/* Stacked one per row, matching the design rather than wrapping inline. */}
      <div className="flex flex-col items-start gap-2">
        {customer.email && (
          <a href={`mailto:${customer.email}`} className={chip}>
            {customer.email}
          </a>
        )}
        {customer.phone && (
          <a href={`tel:${customer.phone}`} className={chip}>
            {customer.phone}
          </a>
        )}
        {!customer.email && !customer.phone && (
          <p className="text-caption text-muted-foreground">
            No contact details on file.
          </p>
        )}
      </div>
    </RailSection>
  );
}

/**
 * Every WhatsApp number and Instagram or Messenger profile linked to the
 * customer. Each stays its own chat: the reply window and opt-in belong to
 * the number. Linking needs the inbox, and is not for viewers.
 */
function ChatsCard({ customer }: { customer: CustomerDetail }) {
  const { canAccess } = useSectionAccess();
  const { role } = useCurrentRole();
  const inbox = canAccess("/inbox");
  const canEdit = inbox && role !== "VIEWER";
  const link = useLinkChatMutation(customer.id);
  const unlink = useUnlinkChatMutation(customer.id);
  const [linking, setLinking] = useState(false);
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "this customer";

  return (
    <div className="rounded-xl bg-card shadow-sm ring-1 ring-border">
      <RailSection
        title="Chats"
        action={
          canEdit && (
            <Button variant="outline" size="xs" onClick={() => setLinking(true)}>
              <Link2 />
              Link a chat
            </Button>
          )
        }
      >
        {customer.chats.length === 0 ? (
          <p className="text-caption text-muted-foreground">No chats are linked to this customer yet.</p>
        ) : (
          <ul className="divide-y">
            {customer.chats.map((chat) => {
              const handle = chatHandle(chat);
              return (
                <li key={chat.contactId} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="mt-0.5">
                    <PlatformIcon platform={chat.platform} size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-medium text-foreground">{handle}</p>
                    <p className="truncate text-micro text-muted-foreground">
                      {[handle !== chat.name ? chat.name : null, chat.channel.name, chat.lastMessageAt ? `Last message ${formatDateTime(chat.lastMessageAt)}` : "No messages yet"]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {inbox && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {chat.conversationId && (
                          <Button asChild variant="outline" size="xs">
                            <Link to={`/inbox?c=${chat.conversationId}`}>
                              <MessageCircle />
                              Open chat
                            </Link>
                          </Button>
                        )}
                        {canEdit && (
                          <Button variant="ghost" size="xs" disabled={unlink.isPending} onClick={() => unlink.mutate(chat.contactId)}>
                            <Unlink />
                            Unlink
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </RailSection>
      {canEdit && (
        <ContactSearchDialog
          open={linking}
          onOpenChange={setLinking}
          title="Link a chat"
          description={`Find a chat by name, number or username to link it to ${name}. A chat linked to another customer has to be unlinked there first.`}
          excludeIds={customer.chats.map((chat) => chat.contactId)}
          isPending={link.isPending}
          onPick={(contact) => link.mutate(contact.id, { onSuccess: () => setLinking(false) })}
        />
      )}
    </div>
  );
}

/**
 * Tag chips with an inline add field.
 *
 * `PATCH /customers/:id` takes the full tag array — there is no add/remove delta
 * endpoint — so every edit sends the whole list. Ported from `OrderTags` in
 * routes/app/orders/$id.tsx, which does the same for orders.
 */
function TagsSection({ customer }: { customer: CustomerDetail }) {
  const mutation = useUpdateCustomerMutation(customer.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const tags = customer.tags ?? [];

  function commit() {
    const next = draft.trim();
    setDraft("");
    setAdding(false);
    if (!next || tags.includes(next)) return;
    mutation.mutate({ tags: [...tags, next] });
  }

  function remove(tag: string) {
    mutation.mutate({ tags: tags.filter((t) => t !== tag) });
  }

  return (
    <RailSection title="Tags">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-caption text-foreground"
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              disabled={mutation.isPending}
              aria-label={`Remove tag ${tag}`}
              className="text-muted-foreground hover:text-danger disabled:opacity-50"
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}

        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder="Tag name"
            className="h-7 w-24 rounded-full border border-border bg-background px-2.5 text-caption outline-none focus:ring-1 focus:ring-brand"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-caption font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Plus className="size-3" />
            Add
          </button>
        )}
      </div>
    </RailSection>
  );
}
