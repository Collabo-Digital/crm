import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Loader2, Plus, X } from "lucide-react";

import { StepFrame } from "~/components/app/onboarding/step-frame";
import { accessGrants, DEFAULT_CAPABILITIES } from "~/components/app/settings/section-access-picker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { StatusBadge } from "~/components/ui/status-badge";
import { useOnboardingWizard, useWizardStep } from "~/hooks/use-onboarding";
import { orgKeys, useOrgInvites } from "~/hooks/use-org-queries";
import { serverMessage } from "~/lib/handle-mutation-error";
import { isEmailAddress } from "~/lib/onboarding-organization";
import { AVAILABLE_SECTIONS, isSectionScopedRole } from "~/lib/sections";
import { cn } from "~/lib/utils";
import { orgService } from "~/services/org.service";
import type { UserRole } from "~/types/api";

export function meta() {
  return [{ title: "Invite your team | Collabo CRM" }];
}

type InviteRole = Extract<UserRole, "ADMIN" | "MANAGER" | "AGENT" | "VIEWER">;

/**
 * What each role can do, as the server enforces it for someone invited here
 * (an Agent or Viewer starts with every section and the default chat access):
 * `true` is full use, a word is a narrower one, `false` is no access.
 */
const ROLES: ReadonlyArray<{
  value: InviteRole;
  label: string;
  does: string;
  inbox: boolean | string;
  orders: boolean | string;
  campaigns: boolean | string;
  team: boolean | string;
}> = [
  { value: "ADMIN", label: "Admin", does: "Runs the workspace", inbox: true, orders: true, campaigns: true, team: true },
  { value: "MANAGER", label: "Manager", does: "Runs day-to-day sales", inbox: true, orders: true, campaigns: true, team: false },
  { value: "AGENT", label: "Agent", does: "Answers customers", inbox: true, orders: "Create, edit", campaigns: "View", team: false },
  { value: "VIEWER", label: "Viewer", does: "Looks, never changes", inbox: "View", orders: "View", campaigns: "View", team: false },
];

const roleLabel = (role: UserRole) => ROLES.find((entry) => entry.value === role)?.label ?? role;

/** Someone typed in but not invited yet, or whose invite the server refused. */
interface PendingInvite {
  email: string;
  role: InviteRole;
  status: "ready" | "sending" | "sent" | "failed";
  error?: string;
}

function Avatar({ email, tone = "neutral" }: { email: string; tone?: "neutral" | "sent" | "failed" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full text-caption font-semibold uppercase",
        tone === "sent" && "bg-brand text-brand-foreground",
        tone === "failed" && "bg-danger-subtle text-danger-text",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {tone === "failed" ? <CircleAlert className="size-4" /> : email.slice(0, 2)}
    </span>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
  className,
}: {
  value: InviteRole;
  onChange: (role: InviteRole) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(role) => onChange(role as InviteRole)} disabled={disabled}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role.value} value={role.value}>
            {role.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Access({ level }: { level: boolean | string }) {
  if (level === true) {
    return (
      <>
        <Check className="mx-auto size-4 text-brand-strong" aria-hidden />
        <span className="sr-only">Yes</span>
      </>
    );
  }
  if (level === false) {
    return (
      <>
        <span aria-hidden className="text-muted-foreground">
          —
        </span>
        <span className="sr-only">No</span>
      </>
    );
  }
  return <span className="text-muted-foreground">{level}</span>;
}

/**
 * Setup step 5, team workspaces only: invite the staff. Optional.
 *
 * People are added to a list first and invited together, one request each,
 * so one refused address (already a member, already invited) doesn't stop
 * the rest: it stays in the list with the server's reason and a Retry.
 * Invites already sent are read back from the server, so returning to the
 * step shows them.
 */
export default function TeamStepPage() {
  const { orgId, orgName } = useOnboardingWizard();
  const step = useWizardStep("team");
  const queryClient = useQueryClient();
  const { data: sentInvites } = useOrgInvites(orgId);

  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<InviteRole>("AGENT");
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [sending, setSending] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);

  const invited = (sentInvites ?? []).filter((invite) => invite.status === "PENDING");
  const invitedEmails = new Set(invited.map((invite) => invite.email.toLowerCase()));
  // A row just sent stays until the server's list carries it, so it never blinks out.
  const rows = pending.filter((row) => !(row.status === "sent" && invitedEmails.has(row.email)));
  const unsent = rows.filter((row) => row.status === "ready" || row.status === "failed");
  const busy = sending || step.isCompleting || step.isLeaving;

  const patchRow = (email: string, patch: Partial<PendingInvite>) =>
    setPending((current) => current.map((row) => (row.email === email ? { ...row, ...patch } : row)));

  function handleAdd() {
    const entries = [...new Set(typed.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
    if (entries.length === 0) return;
    const invalid = entries.filter((entry) => !isEmailAddress(entry));
    const known = new Set([...invitedEmails, ...pending.map((row) => row.email)]);
    const added = entries.filter((entry) => isEmailAddress(entry) && !known.has(entry));

    setPending((current) => [...current, ...added.map((email): PendingInvite => ({ email, role: newRole, status: "ready" }))]);
    // What couldn't be added stays in the box to be fixed.
    setTyped(invalid.join(", "));
    setTypedError(
      invalid.length > 0
        ? `${invalid.length === 1 ? "This doesn't" : "These don't"} look like ${invalid.length === 1 ? "an email address" : "email addresses"}. Fix or remove ${invalid.length === 1 ? "it" : "them"}.`
        : null,
    );
  }

  async function send(row: PendingInvite): Promise<boolean> {
    if (!orgId) return false;
    patchRow(row.email, { status: "sending", error: undefined });
    try {
      await orgService.sendInvite(orgId, {
        email: row.email,
        role: row.role,
        // No per-section picker during setup: an Agent or Viewer starts with
        // every section and the same defaults as the Settings invite, narrowed
        // later from Settings › Team.
        grants: isSectionScopedRole(row.role)
          ? accessGrants(row.role, AVAILABLE_SECTIONS.map((section) => section.id), DEFAULT_CAPABILITIES)
          : undefined,
      });
      patchRow(row.email, { status: "sent" });
      return true;
    } catch (error) {
      patchRow(row.email, { status: "failed", error: serverMessage(error, "The invite couldn't be sent. Try again.") });
      return false;
    }
  }

  /** One request per person, in order. True when every one of them was sent. */
  async function sendAll(): Promise<boolean> {
    setSending(true);
    let allSent = true;
    for (const row of unsent) {
      if (!(await send(row))) allSent = false;
    }
    await queryClient.invalidateQueries({ queryKey: orgKeys.invites(orgId ?? "") });
    setSending(false);
    return allSent;
  }

  async function handleRetry(row: PendingInvite) {
    setSending(true);
    await send(row);
    await queryClient.invalidateQueries({ queryKey: orgKeys.invites(orgId ?? "") });
    setSending(false);
  }

  async function handleContinue() {
    // A refused invite keeps the owner here to see why; the rest have gone.
    if (unsent.length === 0 || (await sendAll())) await step.complete();
  }

  return (
    <StepFrame
      title="Invite your team"
      description={`Each person gets an email to join ${orgName ?? "your workspace"}. You can fine-tune what they see later in Settings › Team.`}
      status="Progress saved"
      exit={
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => (unsent.length > 0 ? setExitDialogOpen(true) : void step.exit())}
        >
          {step.isLeaving && <Loader2 className="animate-spin" aria-hidden />}
          Save & exit
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" asChild>
            <Link to={step.previousPath ?? "/onboarding"}>
              <ArrowLeft aria-hidden />
              Previous
            </Link>
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(unsent.length > 0 || invited.length === 0) && (
              <Button variant="ghost" disabled={busy} onClick={() => void step.complete()}>
                Skip, invite later
              </Button>
            )}
            <Button size="lg" className="h-11 px-5" disabled={busy} onClick={() => void handleContinue()}>
              {(sending || step.isCompleting) && <Loader2 className="animate-spin" aria-hidden />}
              {unsent.length > 0
                ? `Send ${unsent.length} ${unsent.length === 1 ? "invite" : "invites"} & continue`
                : "Continue"}
              {!sending && !step.isCompleting && <ArrowRight aria-hidden />}
            </Button>
          </div>
        </>
      }
    >
      <section className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6">
        <h2 className="text-section">Add people</h2>
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setTypedError(null);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (!/[\r\n]/.test(pasted)) return;
              // A one-line field drops line breaks, which would glue the addresses of a pasted column together.
              event.preventDefault();
              const { selectionStart, selectionEnd } = event.currentTarget;
              const separated = pasted.trim().replace(/\s*[\r\n]+\s*/g, ", ");
              setTyped(typed.slice(0, selectionStart ?? typed.length) + separated + typed.slice(selectionEnd ?? typed.length));
              setTypedError(null);
            }}
            placeholder="name@acmestore.in, another@acmestore.in"
            aria-label="Email addresses"
            aria-invalid={typedError ? true : undefined}
            aria-describedby="invite-emails-help"
            inputMode="email"
            autoComplete="off"
            className="min-w-0 flex-1 basis-64"
          />
          <RoleSelect value={newRole} onChange={setNewRole} label="Role for these people" className="w-32" />
          <Button type="submit" variant="outline" disabled={!typed.trim()}>
            <Plus aria-hidden />
            Add
          </Button>
        </form>
        <p
          id="invite-emails-help"
          className={cn("mt-2 text-caption", typedError ? "text-danger-text" : "text-muted-foreground")}
        >
          {typedError ?? "Paste several at once, separated by commas or new lines."}
        </p>

        {(invited.length > 0 || rows.length > 0) && (
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {invited.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar email={invite.email} tone="sent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">{invite.email}</p>
                  <p className="text-caption text-muted-foreground">{roleLabel(invite.role)}</p>
                </div>
                <StatusBadge tone="success">Invite sent</StatusBadge>
              </li>
            ))}
            {rows.map((row) => (
              <li
                key={row.email}
                className={cn("flex flex-wrap items-center gap-3 px-4 py-3", row.status === "failed" && "bg-danger-subtle/50")}
              >
                <Avatar email={row.email} tone={row.status === "failed" ? "failed" : row.status === "sent" ? "sent" : "neutral"} />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-body font-medium">{row.email}</p>
                  {row.status === "failed" && <p className="text-caption text-danger-text">Couldn't send: {row.error}</p>}
                  {row.status === "sent" && <p className="text-caption text-muted-foreground">{roleLabel(row.role)}</p>}
                </div>
                {row.status === "sent" ? (
                  <StatusBadge tone="success">Invite sent</StatusBadge>
                ) : row.status === "sending" ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Sending" />
                ) : (
                  <>
                    {row.status === "failed" && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleRetry(row)}>
                        Retry
                      </Button>
                    )}
                    <RoleSelect
                      value={row.role}
                      onChange={(role) => patchRow(row.email, { role })}
                      disabled={busy}
                      label={`Role for ${row.email}`}
                      className="w-28"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${row.email}`}
                      onClick={() => setPending((current) => current.filter((entry) => entry.email !== row.email))}
                    >
                      <X />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6">
        <h2 className="text-section">What each role can do</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-lg text-body">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">
                  <span className="sr-only">Role</span>
                </th>
                {["Inbox", "Orders", "Campaigns", "Team & billing"].map((heading) => (
                  <th key={heading} scope="col" className="px-2 py-2 text-center font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ROLES.map((role) => (
                <tr key={role.value}>
                  <th scope="row" className="py-3 text-left font-normal">
                    <span className="block font-semibold">{role.label}</span>
                    <span className="block text-caption text-muted-foreground">{role.does}</span>
                  </th>
                  {[role.inbox, role.orders, role.campaigns, role.team].map((level, index) => (
                    <td key={index} className="px-2 py-3 text-center">
                      <Access level={level} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-caption text-muted-foreground">
          Only you and admins can invite people, connect sales channels and see billing.
        </p>
      </section>

      <Dialog open={exitDialogOpen} onOpenChange={setExitDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {unsent.length === 1 ? "1 person hasn't" : `${unsent.length} people haven't`} been invited yet
            </DialogTitle>
            <DialogDescription>Send the invites before you leave, or leave them for later. The list isn't kept.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setExitDialogOpen(false);
                void step.exit();
              }}
            >
              Exit without sending
            </Button>
            <Button
              onClick={() => {
                setExitDialogOpen(false);
                // A refused invite keeps the owner here to see why.
                void sendAll().then((allSent) => {
                  if (allSent) void step.exit();
                });
              }}
            >
              Send and exit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StepFrame>
  );
}
