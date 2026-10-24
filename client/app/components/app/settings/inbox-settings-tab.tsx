import { useRef, useState } from "react";
import { Loader2, Paperclip, Pencil, Plus, Trash2, Users, X, Zap } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { InboxRulesSection } from "~/components/app/settings/inbox-rules-section";
import { CallingCard } from "~/components/app/settings/calling-card";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  useDeleteQuickReplyMutation,
  useDeleteTeamMutation,
  useSaveQuickReplyMutation,
  useSaveTeamMutation,
  useUploadMutation,
} from "~/hooks/use-inbox-mutations";
import { useInboxMe, useInboxMembers, useInboxTeams, useQuickReplies } from "~/hooks/use-inbox-queries";
import { PRESENCE_DOT, PRESENCE_LABEL } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxShareScope, InboxTeam, QuickReply, QuickReplyAttachment } from "~/types/api";
import { messagingChannelWords } from "~/lib/channel-providers";

const SCOPE_LABEL: Record<InboxShareScope, string> = {
  ORGANIZATION: "Everyone",
  TEAM: "Team",
  PERSONAL: "Only me",
};

function TeamDialog({ team, onClose }: { team: InboxTeam | null; onClose: () => void }) {
  const { data: members = [] } = useInboxMembers();
  const save = useSaveTeamMutation();
  const [name, setName] = useState(team?.name ?? "");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set(team?.members.map((m) => m.id) ?? []));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : "New team"}</DialogTitle>
          <DialogDescription>Conversations can be queued for a team; its members see that queue.</DialogDescription>
        </DialogHeader>
        <form
          id="team-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ id: team?.id, name: name.trim(), memberIds: [...memberIds] }, { onSuccess: onClose });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Name</Label>
            <Input id="team-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Members</Label>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
              {members.map((member) => (
                <label key={member.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-muted">
                  <Checkbox
                    checked={memberIds.has(member.id)}
                    onCheckedChange={(checked) =>
                      setMemberIds((previous) => {
                        const next = new Set(previous);
                        if (checked === true) next.add(member.id);
                        else next.delete(member.id);
                        return next;
                      })
                    }
                  />
                  <span className="flex-1">{member.name}</span>
                  <span className="text-micro text-muted-foreground">{member.role.toLowerCase()}</span>
                </label>
              ))}
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="team-form" variant="accent" disabled={!name.trim() || save.isPending}>
            {team ? "Save team" : "Create team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuickReplyDialog({
  reply,
  canShare,
  teams,
  onClose,
}: {
  reply: QuickReply | null;
  canShare: boolean;
  teams: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const save = useSaveQuickReplyMutation();
  const upload = useUploadMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? "");
  const [body, setBody] = useState(reply?.body ?? "");
  const [keywords, setKeywords] = useState(reply?.keywords.join(", ") ?? "");
  const [scope, setScope] = useState<InboxShareScope>(reply?.scope ?? (canShare ? "ORGANIZATION" : "PERSONAL"));
  const [teamId, setTeamId] = useState(reply?.team?.id ?? teams[0]?.id ?? "");
  const [attachment, setAttachment] = useState<QuickReplyAttachment | null>(reply?.attachment ?? null);
  const validShortcut = /^[a-z0-9_-]{1,30}$/i.test(shortcut);
  const valid = validShortcut && body.trim().length > 0 && (scope !== "TEAM" || !!teamId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reply ? `Edit /${reply.shortcut}` : "New quick reply"}</DialogTitle>
          <DialogDescription>
            Type / and the shortcut in the composer to insert it. {"{{name}}"} becomes the customer’s first name and{" "}
            {"{{agent}}"} yours.
          </DialogDescription>
        </DialogHeader>
        <form
          id="quick-reply-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            save.mutate(
              {
                id: reply?.id,
                shortcut: shortcut.toLowerCase(),
                body,
                keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
                attachment,
                scope,
                ...(scope === "TEAM" ? { teamId } : {}),
              },
              { onSuccess: onClose },
            );
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="qr-shortcut">Shortcut</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">/</span>
                <Input
                  id="qr-shortcut"
                  value={shortcut}
                  maxLength={30}
                  onChange={(e) => setShortcut(e.target.value.replace(/\s+/g, "-"))}
                  placeholder="shipping"
                  className="pl-5"
                  aria-invalid={shortcut.length > 0 && !validShortcut}
                  autoFocus
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qr-scope">Who can use it</Label>
              <div className="flex gap-2">
                <select
                  id="qr-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as InboxShareScope)}
                  disabled={!canShare}
                  className="h-8 flex-1 rounded-lg border bg-background px-2 text-body"
                >
                  <option value="ORGANIZATION">Everyone</option>
                  {teams.length > 0 && <option value="TEAM">A team</option>}
                  <option value="PERSONAL">Only me</option>
                </select>
                {scope === "TEAM" && (
                  <select
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    aria-label="Team"
                    className="h-8 flex-1 rounded-lg border bg-background px-2 text-body"
                  >
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qr-body">Message</Label>
            <Textarea id="qr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4096} placeholder="Hi {{name}}, your order ships within 2 days…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qr-keywords">Keywords</Label>
            <Input id="qr-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="delivery, courier, tracking" />
            <p className="text-micro text-muted-foreground">Comma-separated. The composer also finds the reply by these.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Attachment</Label>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,video/mp4,application/pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                upload.mutate(file, {
                  onSuccess: (uploaded) =>
                    setAttachment({ storageKey: uploaded.storageKey, mime: uploaded.mime, filename: uploaded.filename, mediaKind: uploaded.mediaKind }),
                });
                event.target.value = "";
              }}
            />
            {attachment ? (
              <div className="flex w-fit items-center gap-2 rounded-lg border px-3 py-1.5 text-caption">
                <Paperclip className="size-3.5 text-muted-foreground" />
                {attachment.filename ?? "File"}
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setAttachment(null)} aria-label="Remove attachment">
                  <X />
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
                Attach an image, video or PDF
              </Button>
            )}
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="quick-reply-form" variant="accent" disabled={!valid || save.isPending}>
            {reply ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings → Inbox: teams (who works which queue) and quick replies (saved
 * answers). Owners, admins and managers run teams and shared replies;
 * everyone who replies can keep personal ones.
 */
export function InboxSettingsTab() {
  const { data: me } = useInboxMe();
  const { data: members = [] } = useInboxMembers();
  const { data: teams = [], isLoading: teamsLoading } = useInboxTeams();
  const { data: replies = [], isLoading: repliesLoading } = useQuickReplies(true);
  const deleteTeam = useDeleteTeamMutation();
  const deleteReply = useDeleteQuickReplyMutation();
  const [editingTeam, setEditingTeam] = useState<InboxTeam | null | "new">(null);
  const [editingReply, setEditingReply] = useState<QuickReply | null | "new">(null);
  const canManage = !!me?.access.canManage;
  const canReply = !!me?.access.canReply;
  const teamRefs = teams.map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Inbox</h2>
        <p className="mt-1 text-xs text-muted-foreground">Business hours, auto-replies, routing, teams and saved answers for {messagingChannelWords("and")} chats.</p>
      </div>

      <InboxRulesSection canManage={canManage} members={members.map((m) => ({ id: m.id, name: m.name }))} teams={teamRefs} />

      {canManage && <CallingCard />}

      <SectionCard
        title="Teams"
        description="Queue conversations for a group. Members see their team’s unassigned chats even without access to every chat."
        icon={<Users className="size-4 text-muted-foreground" />}
        action={
          canManage && (
            <Button variant="outline" size="sm" onClick={() => setEditingTeam("new")}>
              <Plus />
              New team
            </Button>
          )
        }
      >
        {teamsLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : teams.length === 0 ? (
          <p className="px-5 py-6 text-caption text-muted-foreground">No teams yet.</p>
        ) : (
          <ul className="divide-y">
            {teams.map((team) => (
              <li key={team.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium">{team.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
                    {team.members.length === 0
                      ? "No members"
                      : team.members.map((member) => (
                          <span key={member.id} className="inline-flex items-center gap-1" title={PRESENCE_LABEL[member.presence]}>
                            <span className={cn("size-1.5 rounded-full", PRESENCE_DOT[member.presence])} />
                            {member.name}
                          </span>
                        ))}
                  </p>
                </div>
                <span className="text-caption tabular-nums text-muted-foreground">{team.openConversations} open</span>
                {canManage && (
                  <div className="flex">
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditingTeam(team)} aria-label={`Edit ${team.name}`}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => window.confirm(`Delete ${team.name}? Its conversations stay, without a team.`) && deleteTeam.mutate(team.id)}
                      aria-label={`Delete ${team.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Quick replies"
        description="Type / in the composer to use them."
        icon={<Zap className="size-4 text-muted-foreground" />}
        action={
          canReply && (
            <Button variant="outline" size="sm" onClick={() => setEditingReply("new")}>
              <Plus />
              New quick reply
            </Button>
          )
        }
      >
        {repliesLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : replies.length === 0 ? (
          <p className="px-5 py-6 text-caption text-muted-foreground">No quick replies yet.</p>
        ) : (
          <ul className="divide-y">
            {replies.map((reply) => (
              <li key={reply.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-body font-medium">
                    /{reply.shortcut}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
                      {reply.scope === "TEAM" ? reply.team?.name : SCOPE_LABEL[reply.scope]}
                    </span>
                    {reply.attachment && <Paperclip className="size-3.5 text-muted-foreground" />}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">{reply.body}</p>
                </div>
                {reply.canEdit && (
                  <div className="flex">
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditingReply(reply)} aria-label={`Edit /${reply.shortcut}`}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => window.confirm(`Delete /${reply.shortcut}?`) && deleteReply.mutate(reply.id)}
                      aria-label={`Delete /${reply.shortcut}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editingTeam && <TeamDialog team={editingTeam === "new" ? null : editingTeam} onClose={() => setEditingTeam(null)} />}
      {editingReply && (
        <QuickReplyDialog
          reply={editingReply === "new" ? null : editingReply}
          canShare={canManage}
          teams={teamRefs}
          onClose={() => setEditingReply(null)}
        />
      )}
    </div>
  );
}
