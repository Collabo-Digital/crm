import { useEffect, useState } from "react";
import { Check, Copy, Download, Link2, Loader2, MessageSquare, RefreshCw, Trash2, UserMinus, Users } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useCreateGroup, useGroup, useGroupAction, useGroups } from "~/hooks/use-groups";
import { downloadBlob } from "~/lib/download-blob";
import { formatDateTime } from "~/lib/format-date";
import { STATUS_TONE_CLASSES } from "~/lib/status-tone";
import { cn } from "~/lib/utils";
import { groupsService } from "~/services/groups.service";
import type { WhatsAppGroupStatus, WhatsAppGroupSummary } from "~/types/api";

export function meta() {
  return [{ title: "WhatsApp groups | Collabo CRM" }];
}

const MAX_PEOPLE = 8;
const selectClass = "h-9 w-full min-w-0 rounded-lg border bg-background px-2 text-body";

const STATUS: Record<WhatsAppGroupStatus, { label: string; tone: string }> = {
  CREATING: { label: "Creating…", tone: STATUS_TONE_CLASSES.neutral },
  ACTIVE: { label: "Active", tone: STATUS_TONE_CLASSES.success },
  SUSPENDED: { label: "Suspended by WhatsApp", tone: STATUS_TONE_CLASSES.attention },
  DELETING: { label: "Deleting…", tone: STATUS_TONE_CLASSES.neutral },
  DELETED: { label: "Deleted", tone: STATUS_TONE_CLASSES.neutral },
  FAILED: { label: "Not created", tone: STATUS_TONE_CLASSES.critical },
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function NewGroupForm({ numbers }: { numbers: Array<{ channelId: string; name: string }> }) {
  const create = useCreateGroup();
  const [channelId, setChannelId] = useState(numbers[0]?.channelId ?? "");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [approval, setApproval] = useState<"auto_approve" | "approval_required">("auto_approve");
  return (
    <SectionCard title="New group" icon={<Users className="size-4 text-muted-foreground" />} description="Up to 8 customers besides your business. People join with the invite link; you cannot add them yourself.">
      <form
        className="grid gap-4 p-5 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { channelId, subject: subject.trim(), description: description.trim() || undefined, joinApprovalMode: approval },
            { onSuccess: () => { setSubject(""); setDescription(""); } },
          );
        }}
      >
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="group-subject">Name</Label>
          <Input id="group-subject" value={subject} maxLength={128} onChange={(e) => setSubject(e.target.value)} placeholder="Summer drop insiders" />
        </div>
        {numbers.length > 1 && (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="group-number">WhatsApp number</Label>
            <select id="group-number" className={selectClass} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {numbers.map((n) => <option key={n.channelId} value={n.channelId}>{n.name}</option>)}
            </select>
          </div>
        )}
        <div className="min-w-0 space-y-1.5 md:col-span-2">
          <Label htmlFor="group-description">Description (optional)</Label>
          <Textarea id="group-description" rows={2} maxLength={2048} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="First look at new arrivals, styling help, and early access." />
        </div>
        <fieldset className="space-y-2 md:col-span-2">
          <legend className="text-caption font-medium">Who gets in</legend>
          {([["auto_approve", "Anyone with the invite link"], ["approval_required", "People I approve (they ask with the link)"]] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-body">
              <input type="radio" name="join-approval" value={value} checked={approval === value} onChange={() => setApproval(value)} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="md:col-span-2">
          <Button type="submit" disabled={!subject.trim() || !channelId || create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Create group
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function InviteQr({ group }: { group: WhatsAppGroupSummary }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    void groupsService.qr(group.id, "svg").then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [group.id, group.inviteLink]);
  const file = `${group.subject.replace(/[^\w-]+/g, "-")}-invite.png`;
  return (
    <div className="flex flex-wrap items-center gap-4">
      {url ? <img src={url} alt={`QR code to join ${group.subject}`} className="size-32 rounded bg-white p-1" /> : <Skeleton className="size-32" />}
      <Button size="sm" variant="outline" onClick={() => void downloadBlob(() => groupsService.qr(group.id, "png"), file, "The QR code was not downloaded.")}>
        <Download />
        QR for print
      </Button>
    </div>
  );
}

function ManageGroup({ id, canManage }: { id: string; canManage: boolean }) {
  const { data: group, isLoading, isError, refetch } = useGroup(id);
  const act = useGroupAction(id);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  if (isError && !group) return <QueryErrorState resource="this group" onRetry={() => void refetch()} />;
  if (isLoading || !group) return <Skeleton className="h-40 w-full" />;
  const live = group.status === "ACTIVE" || group.status === "SUSPENDED";
  return (
    <div className="space-y-5 border-t bg-muted/20 p-5">
      {group.statusReason && <p className="text-caption text-warning">{group.statusReason}</p>}
      {group.inviteLink && live && (
        <div className="space-y-3">
          <p className="text-caption font-medium">Invite link</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 max-w-full truncate rounded bg-muted px-2 py-1 text-caption">{group.inviteLink}</code>
            <CopyButton text={group.inviteLink} label="Copy link" />
            {canManage && (
              <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => window.confirm("Make a new invite link? The current link stops working.") && act.mutate({ kind: "reset-link" })}>
                <Link2 />
                New link
              </Button>
            )}
          </div>
          <InviteQr group={group} />
          <p className="text-micro text-muted-foreground">Share it in a chat, on packaging or in a post. Meta also offers a ready “group invite link” utility template in WhatsApp Manager’s template library.</p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-caption font-medium">
          People · {group.participants.length} of {MAX_PEOPLE}
        </p>
        {group.participants.length === 0 ? (
          <p className="text-caption text-muted-foreground">Nobody has joined yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {group.participants.map((p) => (
              <li key={p.waId} className="flex items-center gap-3 px-3 py-2 text-caption">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name ?? `+${p.waId}`}</span>
                  <span className="block text-micro text-muted-foreground">+{p.waId} · joined {formatDateTime(p.joinedAt)}</span>
                </span>
                {canManage && live && (
                  <Button size="xs" variant="ghost" disabled={act.isPending} aria-label={`Remove ${p.name ?? p.waId}`} onClick={() => window.confirm(`Remove ${p.name ?? `+${p.waId}`}? They cannot rejoin with the link.`) && act.mutate({ kind: "remove-participant", waId: p.waId })}>
                    <UserMinus />
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {group.joinRequests.length > 0 && (
        <div className="space-y-2">
          <p className="text-caption font-medium">Asking to join</p>
          <ul className="divide-y rounded-lg border bg-card">
            {group.joinRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-caption">
                <span className="min-w-0 flex-1">+{r.waId} · {formatDateTime(r.requestedAt)}</span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button size="xs" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ kind: "decide", requestId: r.id, approve: true })}>Approve</Button>
                    <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: "decide", requestId: r.id, approve: false })}>Decline</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage && live && editing && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ kind: "update", subject: subject.trim(), description: description.trim() }, { onSuccess: () => setEditing(false) });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`subject-${id}`}>Name</Label>
            <Input id={`subject-${id}`} value={subject} maxLength={128} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`description-${id}`}>Description</Label>
            <Textarea id={`description-${id}`} rows={2} maxLength={2048} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!subject.trim() || act.isPending}>Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {live && !editing && (
            <Button size="sm" variant="outline" onClick={() => { setSubject(group.subject); setDescription(group.description ?? ""); setEditing(true); }}>
              Edit name and description
            </Button>
          )}
          {live && (
            <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: "refresh" })}>
              <RefreshCw />
              Refresh from WhatsApp
            </Button>
          )}
          {group.status !== "DELETING" && (
            <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => window.confirm(`Delete “${group.subject}”? WhatsApp removes everyone, your business included. The chat history stays in Collabo.`) && act.mutate({ kind: "delete" })}>
              <Trash2 />
              Delete group
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * WhatsApp groups run from Collabo: small communities of up to 8 customers on
 * the business's number (VIP drops, workshops, order help). Each group's chat
 * lives in the inbox; this page makes groups and manages who is in them.
 */
export default function WhatsAppGroupsPage() {
  const { data, isLoading, isError, refetch } = useGroups();
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const [params, setParams] = useSearchParams();
  const open = params.get("g");
  const available = data?.numbers.filter((n) => n.available) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>WhatsApp groups</PageHeaderTitle>
          <PageHeaderDescription>Small groups of customers on your WhatsApp number. Their chats appear in your inbox like any conversation.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {isError && !data ? (
        <QueryErrorState resource="your WhatsApp groups" onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {available.length === 0 && (
            <div className="rounded-xl border bg-card p-5 text-caption text-muted-foreground">
              <p className="font-medium text-foreground">None of your WhatsApp numbers can run groups.</p>
              <p className="mt-1">Meta allows groups only on numbers using the Cloud API with an Official Business Account (the blue tick), never on a number shared with the WhatsApp Business app.</p>
              {data.numbers.map((n) => n.reason && <p key={n.channelId} className="mt-1">{n.name}: {n.reason}</p>)}
            </div>
          )}
          {canManage && available.length > 0 && <NewGroupForm numbers={available} />}

          {data.groups.length === 0 ? (
            <p className="text-caption text-muted-foreground">No groups yet.</p>
          ) : (
            <ul className="space-y-3">
              {data.groups.map((g) => (
                <li key={g.id} className="overflow-hidden rounded-xl border bg-card">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/30 text-brand-strong">
                      <Users className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-body font-semibold">{g.subject}</p>
                        <span className={cn("rounded-full px-2 py-0.5 text-micro font-medium", STATUS[g.status].tone)}>{STATUS[g.status].label}</span>
                        {g.pendingJoinRequests > 0 && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-micro font-medium">{g.pendingJoinRequests} asking to join</span>}
                      </div>
                      <p className="text-micro text-muted-foreground">
                        {g.channelName} · {g.participantCount} of {MAX_PEOPLE} people · {g.joinApprovalMode === "approval_required" ? "you approve who joins" : "anyone with the link joins"}
                      </p>
                      {g.status === "FAILED" && g.statusReason && <p className="text-micro text-destructive">{g.statusReason}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {g.conversationId && (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={`/inbox?c=${g.conversationId}`}>
                            <MessageSquare />
                            Open chat
                          </Link>
                        </Button>
                      )}
                      {g.status !== "CREATING" && g.status !== "FAILED" && (
                        <Button size="sm" variant={open === g.id ? "secondary" : "ghost"} onClick={() => setParams(open === g.id ? {} : { g: g.id }, { replace: true })}>
                          {open === g.id ? "Close" : "Manage"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {open === g.id && <ManageGroup id={g.id} canManage={canManage} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
