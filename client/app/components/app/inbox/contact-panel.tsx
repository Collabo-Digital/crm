import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Ban, Link2, Package, Search, Unlink, X } from "lucide-react";
import { Link } from "react-router";

import { ChannelBadge } from "~/components/app/channel-badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useDebounced } from "~/hooks/use-debounced";
import { useRecordConsentMutation, useUpdateContactMutation } from "~/hooks/use-inbox-mutations";
import { useCustomerCandidates } from "~/hooks/use-inbox-queries";
import { formatBubbleTime, formatDateTime, formatRowTime } from "~/lib/inbox-format";
import { FINANCIAL_CLASSES, FINANCIAL_LABELS, FULFILLMENT_LABELS } from "~/lib/order-status";
import { cn, formatCurrency } from "~/lib/utils";
import type { InboxContactDetail, InboxCustomerMatch, InboxMember, InboxNote, InboxTeamRef } from "~/types/api";

import { PaymentsSection } from "./payments-section";
import { TagChip } from "./tag-chip";

const NONE = "none";

/**
 * A titled block inside the panel: one card with hairline dividers, the
 * parent supplying `divide-y`. Same shape as the customer page's rail.
 */
function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** Enter commits, Escape abandons — the same interaction as the customer page's tags. */
function InlineAdd({ placeholder, label, onAdd }: { placeholder: string; label: string; onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue("");
  };
  return (
    <Input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          setValue("");
          event.currentTarget.blur();
        }
      }}
      aria-label={label}
      placeholder={placeholder}
      className="h-7 text-caption"
    />
  );
}

/** Search the store's customers and link one; matches by phone show first. */
function LinkCustomer({
  contactId,
  phoneMatches,
  onLink,
  disabled,
}: {
  contactId: string;
  phoneMatches: InboxCustomerMatch[];
  onLink: (customer: InboxCustomerMatch) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim());
  const search = useCustomerCandidates(contactId, debounced, open && debounced.length >= 2);
  const results = debounced.length >= 2 ? (search.data?.results ?? []) : phoneMatches;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={disabled}>
          <Search />
          Find customer
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name, email or phone" aria-label="Search customers" autoFocus />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-1 py-2 text-caption text-muted-foreground">
              {debounced.length >= 2 ? (search.isFetching ? "Searching…" : "No customers match.") : "Type at least two characters."}
            </p>
          ) : (
            results.map((customer) => (
              <button
                key={customer.id}
                type="button"
                onClick={() => {
                  onLink(customer);
                  setOpen(false);
                }}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="text-caption font-medium">{customer.name ?? customer.email ?? customer.phone ?? "Customer"}</span>
                <span className="text-micro text-muted-foreground">
                  {[customer.email, customer.phone, `${customer.ordersCount} orders`].filter(Boolean).join(" · ")}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Column 3 — who this person is to the business: the store customer and
 * their orders, the same person on other channels, tags, owner, consent,
 * custom fields and the team's notes.
 */
export function ContactPanel({
  contact,
  conversationId,
  notes,
  members,
  teams,
  canEdit,
  canAssignOthers,
  meId,
  defaultCurrency,
  onAddNote,
  isSavingNote,
  className,
}: {
  contact: InboxContactDetail;
  conversationId: string;
  notes: InboxNote[];
  members: InboxMember[];
  teams: InboxTeamRef[];
  canEdit: boolean;
  canAssignOthers: boolean;
  meId: string | undefined;
  defaultCurrency: string;
  onAddNote: (body: string) => void;
  isSavingNote: boolean;
  className?: string;
}) {
  const update = useUpdateContactMutation(contact.id);
  const consent = useRecordConsentMutation(contact.id);
  const [attrKey, setAttrKey] = useState("");
  const [attrValue, setAttrValue] = useState("");

  const { customer } = contact;
  const currency = customer?.recentOrders[0]?.currency ?? defaultCurrency;
  const otherConversations = contact.conversations.filter((c) => c.id !== conversationId);
  const duplicateNumber = contact.phoneMatches.length > 1 || (!!customer && contact.phoneMatches.some((m) => m.id !== customer.id));
  const owners = canAssignOthers ? members : members.filter((m) => m.id === meId);
  const attributes = Object.entries(contact.attributes);

  return (
    <aside aria-label="Contact details" className={cn("min-h-0 divide-y overflow-y-auto", className)}>
      {customer && (
        <div className="grid grid-cols-2 divide-x">
          <div className="px-4 py-4">
            <p className="text-micro uppercase tracking-wider text-muted-foreground">Lifetime spend</p>
            <p className="mt-1 text-section text-foreground">
              {formatCurrency(customer.totalSpent, currency, { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="px-4 py-4">
            <p className="text-micro uppercase tracking-wider text-muted-foreground">Orders</p>
            <p className="mt-1 text-section text-foreground tabular-nums">{customer.ordersCount}</p>
          </div>
        </div>
      )}

      <PanelSection title="Contact">
        <dl className="space-y-1.5 text-caption">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Channel</dt>
            <dd>
              <ChannelBadge platform={contact.platform} size={11} />
            </dd>
          </div>
          {contact.phone && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="tabular-nums">{contact.phone}</dd>
            </div>
          )}
          {contact.username && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Username</dt>
              <dd className="truncate">@{contact.username}</dd>
            </div>
          )}
          {contact.addressBookName && contact.addressBookName !== contact.name && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Saved as</dt>
              <dd className="truncate">{contact.addressBookName}</dd>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">First seen</dt>
            <dd>{formatDateTime(contact.firstSeenAt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Owner</dt>
            <dd>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" disabled={!canEdit || update.isPending} className="-mr-2">
                    {[contact.owner.user?.name, contact.owner.team?.name].filter(Boolean).join(" · ") || "Nobody"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
                  <DropdownMenuLabel>Owner</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={contact.owner.user?.id ?? NONE}
                    onValueChange={(value) => update.mutate({ ownerUserId: value === NONE ? null : value, done: "Owner updated." })}
                  >
                    <DropdownMenuRadioItem value={NONE}>Nobody</DropdownMenuRadioItem>
                    {owners.map((member) => (
                      <DropdownMenuRadioItem key={member.id} value={member.id}>
                        {member.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {canAssignOthers && teams.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Owning team</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={contact.owner.team?.id ?? NONE}
                        onValueChange={(value) => update.mutate({ ownerTeamId: value === NONE ? null : value, done: "Team updated." })}
                      >
                        <DropdownMenuRadioItem value={NONE}>No team</DropdownMenuRadioItem>
                        {teams.map((team) => (
                          <DropdownMenuRadioItem key={team.id} value={team.id}>
                            {team.name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </dd>
          </div>
        </dl>
      </PanelSection>

      <PanelSection title="Tags">
        <div className="space-y-2">
          {contact.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {contact.tags.map((tag) => (
                <TagChip
                  key={tag}
                  tag={tag}
                  onRemove={canEdit ? () => update.mutate({ tags: contact.tags.filter((t) => t !== tag) }) : undefined}
                />
              ))}
            </div>
          )}
          {canEdit && (
            <InlineAdd
              label="Add a tag"
              placeholder="Add a tag"
              onAdd={(tag) => !contact.tags.includes(tag) && update.mutate({ tags: [...contact.tags, tag] })}
            />
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Store customer"
        action={
          customer ? (
            canEdit && (
              <Button variant="ghost" size="xs" onClick={() => update.mutate({ customerId: null, done: "Customer unlinked." })} disabled={update.isPending}>
                <Unlink />
                Unlink
              </Button>
            )
          ) : (
            canEdit && (
              <LinkCustomer
                contactId={contact.id}
                phoneMatches={contact.phoneMatches}
                disabled={update.isPending}
                onLink={(match) => update.mutate({ customerId: match.id, done: `Linked to ${match.name ?? "the customer"}.` })}
              />
            )
          )
        }
      >
        {duplicateNumber && (
          <p className="mb-2.5 flex items-start gap-1.5 rounded-md bg-warning-subtle px-2.5 py-2 text-micro text-warning-strong">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            This number belongs to {contact.phoneMatches.length} store customers. Check that the right one is linked.
          </p>
        )}
        {customer ? (
          <div className="space-y-2">
            <div>
              <Link to={`/orders/customers/${customer.id}`} className="text-caption font-medium text-foreground hover:underline">
                {customer.name ?? customer.email ?? "Customer"}
              </Link>
              <p className="text-micro text-muted-foreground">{[customer.email, customer.phone].filter(Boolean).join(" · ")}</p>
            </div>
            {customer.recentOrders.length === 0 ? (
              <p className="text-caption text-muted-foreground">No orders yet.</p>
            ) : (
              customer.recentOrders.map((order) => (
                <div key={order.id} className="flex items-center gap-2">
                  <Package className="size-3.5 shrink-0 text-muted-foreground" />
                  <Link to={`/orders/${order.id}`} className="text-caption font-medium hover:underline">
                    {order.name}
                  </Link>
                  <span className={cn("rounded-full px-1.5 py-0.5 text-micro font-medium", FINANCIAL_CLASSES[order.financialStatus])}>
                    {order.cancelledAt ? "Cancelled" : FINANCIAL_LABELS[order.financialStatus]}
                  </span>
                  <span className="ml-auto text-caption tabular-nums">
                    {formatCurrency(order.totalPrice, order.currency, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              ))
            )}
            {customer.recentOrders[0] && (
              <p className="text-micro text-muted-foreground">
                Last order {formatDateTime(customer.recentOrders[0].createdAt)} ·{" "}
                {FULFILLMENT_LABELS[customer.recentOrders[0].fulfillmentStatus]}
              </p>
            )}
          </div>
        ) : contact.phoneMatches.length === 1 && canEdit ? (
          <div className="space-y-1.5">
            <p className="text-caption text-muted-foreground">One store customer has this number:</p>
            <Button
              variant="outline"
              size="xs"
              disabled={update.isPending}
              onClick={() => update.mutate({ customerId: contact.phoneMatches[0].id, done: "Customer linked." })}
            >
              <Link2 />
              Link {contact.phoneMatches[0].name ?? contact.phoneMatches[0].email ?? "customer"}
            </Button>
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">Not linked to a store customer.</p>
        )}
      </PanelSection>

      <PanelSection title="Payments">
        <PaymentsSection conversationId={conversationId} canEdit={canEdit} />
      </PanelSection>

      {otherConversations.length > 0 && (
        <PanelSection title="Other conversations">
          <div className="space-y-1.5">
            {otherConversations.map((c) => (
              <Link
                key={c.id}
                to={`/inbox?c=${c.id}`}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
              >
                <ChannelBadge platform={c.platform} name={c.channel.name} size={11} className="shrink-0 text-micro" />
                <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{c.lastMessagePreview}</span>
                <span className="shrink-0 text-micro text-muted-foreground">{formatRowTime(c.lastMessageAt, Date.now())}</span>
              </Link>
            ))}
          </div>
        </PanelSection>
      )}

      <PanelSection title="Marketing consent">
        <div className="space-y-2">
          <p className="text-caption">
            {contact.optedOutAt ? (
              <span className="text-warning-strong">Opted out {formatDateTime(contact.optedOutAt)}</span>
            ) : contact.optInAt ? (
              <span className="text-success">Subscribed {formatDateTime(contact.optInAt)}</span>
            ) : (
              <span className="text-muted-foreground">No consent recorded</span>
            )}
          </p>
          {canEdit && (
            <Button
              variant="outline"
              size="xs"
              disabled={consent.isPending}
              onClick={() => consent.mutate({ type: contact.optedOutAt || !contact.optInAt ? "OPT_IN" : "OPT_OUT" })}
            >
              {contact.optedOutAt || !contact.optInAt ? "Mark as subscribed" : "Mark as opted out"}
            </Button>
          )}
          {contact.consent.length > 0 && (
            <ul className="space-y-0.5 text-micro text-muted-foreground">
              {contact.consent.map((event, index) => (
                <li key={index}>
                  {event.type === "OPT_IN" ? "Subscribed" : "Opted out"} · {event.source} · {formatDateTime(event.occurredAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Attributes">
        <div className="space-y-1.5">
          {attributes.length === 0 && !canEdit && <p className="text-caption text-muted-foreground">None.</p>}
          {attributes.map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 text-caption">
              <span className="w-24 shrink-0 truncate text-muted-foreground">{key}</span>
              <span className="min-w-0 flex-1 truncate">{String(value)}</span>
              {canEdit && (
                <Button variant="ghost" size="icon-xs" onClick={() => update.mutate({ attributes: { [key]: null } })} aria-label={`Remove ${key}`}>
                  <X />
                </Button>
              )}
            </div>
          ))}
          {canEdit && (
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const key = attrKey.trim();
                if (!key || !attrValue.trim()) return;
                update.mutate({ attributes: { [key]: attrValue.trim() } });
                setAttrKey("");
                setAttrValue("");
              }}
            >
              <Input value={attrKey} onChange={(e) => setAttrKey(e.target.value)} placeholder="Field" aria-label="Attribute name" className="h-7 w-24 text-caption" />
              <Input value={attrValue} onChange={(e) => setAttrValue(e.target.value)} placeholder="Value" aria-label="Attribute value" className="h-7 min-w-0 flex-1 text-caption" />
              <Button type="submit" variant="ghost" size="xs" disabled={!attrKey.trim() || !attrValue.trim()}>
                Add
              </Button>
            </form>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Internal notes">
        <div className="space-y-2">
          {/* Newest first here, unlike the thread: the panel is a reference list. */}
          {[...notes].reverse().map((note) => (
            <div key={note.id} className="rounded-lg border-l-2 border-warning bg-warning-subtle px-2.5 py-2">
              <p className="text-caption whitespace-pre-wrap break-words text-foreground">{note.body}</p>
              <p className="mt-1 text-micro text-muted-foreground">
                {note.author?.name ?? "Former member"} · {formatBubbleTime(note.createdAt)}
              </p>
            </div>
          ))}
          {canEdit && (
            <InlineAdd label="Add an internal note" placeholder={isSavingNote ? "Saving…" : "Add a note — only your team sees it"} onAdd={onAddNote} />
          )}
        </div>
      </PanelSection>

      {canEdit && (
        <div className="px-4 py-4">
          <Button
            variant={contact.blockedAt ? "outline" : "destructive"}
            size="xs"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                blocked: !contact.blockedAt,
                done: contact.blockedAt ? "Contact unblocked." : "Contact blocked. Nothing will be sent to them.",
              })
            }
          >
            <Ban />
            {contact.blockedAt ? "Unblock contact" : "Block contact"}
          </Button>
        </div>
      )}
    </aside>
  );
}
