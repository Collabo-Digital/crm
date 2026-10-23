import { useState } from "react";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SectionCard } from "~/components/app/section-card";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { CHANNEL_ICON } from "~/components/app/channel-badge";
import { useInfluencers } from "~/hooks/use-org-queries";
import { useResendInviteMutation } from "~/hooks/use-org-mutations";
import { InviteInfluencerDialog } from "./invite-influencer-dialog";
import { CancelInviteDialog } from "./cancel-invite-dialog";
import { cn } from "~/lib/utils";
import type { InfluencerRow } from "~/types/api";

/**
 * How each state reads, and what it affords.
 *
 * The action differs by state on purpose: a cancelled invitation says "Invite
 * again" and an expired one "Send new invitation", because those are different
 * situations to the admin even though both post to the same endpoint.
 */
const STATUS_META: Record<
  InfluencerRow["status"],
  { label: string; className: string }
> = {
  ACTIVE: { label: "Active", className: "bg-success-subtle text-success" },
  PENDING: { label: "Pending", className: "bg-warning-subtle text-warning-strong" },
  EXPIRED: { label: "Expired", className: "bg-muted text-muted-foreground" },
  REVOKED: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
  ACCEPTED: { label: "Active", className: "bg-success-subtle text-success" },
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The Instagram accounts this influencer has connected, or a dash. */
function InstagramCell({ row }: { row: InfluencerRow }) {
  const instagram = row.channels.filter((c) => c.platform === "INSTAGRAM");
  if (instagram.length === 0) {
    return <span className="text-caption text-muted-foreground">—</span>;
  }
  const Icon = CHANNEL_ICON.INSTAGRAM;
  return (
    <div className="space-y-1">
      {instagram.map((channel) => (
        <span key={channel.id} className="flex items-center gap-1.5 text-body">
          {Icon ? <Icon key={channel.id} width={14} height={14} /> : null}
          {channel.externalStoreUrl ? (
            <a
              href={channel.externalStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-strong hover:underline"
            >
              {channel.name}
            </a>
          ) : (
            channel.name
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Influencer management: everyone invited, joined or not, with the Instagram
 * account they connected.
 *
 * Deliberately separate from channel connection. This is where an organization
 * invites and tracks people; the influencer connects their own account from
 * Settings -> Channels. The Instagram column here READS the channel system
 * rather than keeping a second copy of the connection for display.
 */
export function InfluencersSection({
  orgId,
  canManage,
  isPersonalWorkspace,
}: {
  orgId: string;
  canManage: boolean;
  /**
   * Personal workspaces are solo by design and the server refuses every invite
   * on them. Offering the button anyway would be an action that can only fail.
   */
  isPersonalWorkspace: boolean;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<InfluencerRow | null>(null);
  const { data: rows, isLoading, isError, refetch } = useInfluencers(orgId);
  const resend = useResendInviteMutation(orgId);
  // Track which row is resending, so only that button shows a spinner.
  const [resendingId, setResendingId] = useState<string | null>(null);

  const canInvite = canManage && !isPersonalWorkspace;
  const inviteButton = canInvite ? (
    <Button variant="accent" size="sm" onClick={() => setInviteOpen(true)}>
      <Plus />
      Invite influencer
    </Button>
  ) : undefined;

  // Nothing to manage and nothing that can be created: say why, once, instead
  // of an empty table under a disabled button.
  if (isPersonalWorkspace) {
    return (
      <SectionCard
        title="Influencers"
        description="People invited to collaborate and connect their own Instagram account."
      >
        <div className="px-5 py-6">
          <p className="text-body text-foreground">
            Personal workspaces are for one person.
          </p>
          <p className="mt-1 text-caption text-muted-foreground">
            Create an organization to invite influencers and collaborate with
            them.
          </p>
        </div>
      </SectionCard>
    );
  }

  function handleResend(row: InfluencerRow) {
    if (!row.inviteId) return;
    setResendingId(row.inviteId);
    resend.mutate(row.inviteId, { onSettled: () => setResendingId(null) });
  }

  return (
    <>
      <SectionCard
        title="Influencers"
        description="People invited to collaborate and connect their own Instagram account."
        action={inviteButton}
      >
        {/* Error before empty, deliberately: the empty state invites an action
            the admin may have already taken, and showing it on a failed request
            would suggest the invitations they sent had vanished. */}
        {isError && !rows ? (
          <div className="p-5">
            <QueryErrorState resource="your influencers" onRetry={() => refetch()} />
          </div>
        ) : isLoading ? (
          <div className="p-5">
            <TableSkeleton rows={3} columns={5} />
          </div>
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No influencers invited yet"
            description="Invite influencers to connect their Instagram accounts and collaborate with your organization."
            action={inviteButton}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Influencer</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invited</TableHead>
                  <TableHead>Instagram</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const meta = STATUS_META[row.status] ?? STATUS_META.PENDING;
                  const isActive = row.kind === "MEMBER";
                  const isResending = resendingId === row.inviteId;
                  return (
                    <TableRow
                      key={row.inviteId ?? row.memberId ?? row.email}
                      className={cn(!isActive && "text-muted-foreground")}
                    >
                      <TableCell className="text-body text-foreground">
                        {row.name || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-body">{row.email}</TableCell>
                      <TableCell>
                        <Badge className={meta.className}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-caption">
                        {formatDate(row.invitedAt)}
                      </TableCell>
                      <TableCell>
                        <InstagramCell row={row} />
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {row.status === "PENDING" && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={isResending}
                                  onClick={() => handleResend(row)}
                                >
                                  {isResending && <Loader2 className="animate-spin" />}
                                  Resend
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger hover:text-danger"
                                  onClick={() => setCancelTarget(row)}
                                >
                                  Cancel
                                </Button>
                              </>
                            )}
                            {(row.status === "EXPIRED" || row.status === "REVOKED") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isResending}
                                onClick={() => handleResend(row)}
                              >
                                {isResending && <Loader2 className="animate-spin" />}
                                {row.status === "EXPIRED"
                                  ? "Send new invitation"
                                  : "Invite again"}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {canInvite && (
        <>
          <InviteInfluencerDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            orgId={orgId}
          />
          <CancelInviteDialog
            invite={cancelTarget}
            orgId={orgId}
            onOpenChange={(open) => !open && setCancelTarget(null)}
          />
        </>
      )}
    </>
  );
}
