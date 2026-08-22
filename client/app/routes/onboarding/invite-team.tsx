import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { isAxiosError } from "axios";
import {
  Users, Plus, X, Loader2, ArrowLeft, ArrowRight, Mail, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useSendInviteMutation } from "~/hooks/use-org-mutations";
import type { UserRole } from "~/types/api";

export function meta() {
  return [{ title: "Invite Your Team | Collabo CRM" }];
}

interface InviteRow {
  id: string;
  email: string;
  role: UserRole;
  status: "idle" | "sending" | "sent" | "error";
  error?: string;
}

const ROLES: { value: UserRole; label: string; description: string }[] = [
  { value: "ADMIN", label: "Admin", description: "Full access, manage team" },
  { value: "MANAGER", label: "Manager", description: "Manage orders & customers" },
  { value: "AGENT", label: "Agent", description: "Handle conversations" },
  { value: "VIEWER", label: "Viewer", description: "Read-only access" },
];

/** Delay (in ms) before checking if all invites were sent and redirecting. */
const REDIRECT_CHECK_DELAY = 300;

/** Delay (in ms) after success toast before navigating to the dashboard. */
const REDIRECT_NAVIGATE_DELAY = 1200;

/**
 * Onboarding step 3: invite team members to the organization.
 * Allows adding multiple email/role rows and sending invitations in sequence.
 */
export default function InviteTeamPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const orgId = searchParams.get("orgId") ?? "";

  const [rows, setRows] = useState<InviteRow[]>([
    { id: crypto.randomUUID(), email: "", role: "AGENT", status: "idle" },
  ]);
  const [isSendingAll, setIsSendingAll] = useState(false);

  const sendInvite = useSendInviteMutation(orgId);

  /* ── Row management handlers ─────────────────────────── */

  function handleAddRow() {
    setRows((previousRows) => [
      ...previousRows,
      { id: crypto.randomUUID(), email: "", role: "AGENT", status: "idle" },
    ]);
  }

  function handleRemoveRow(id: string) {
    setRows((previousRows) => previousRows.filter((row) => row.id !== id));
  }

  function handleEmailChange(id: string, email: string) {
    setRows((previousRows) =>
      previousRows.map((row) => (row.id === id ? { ...row, email, status: "idle", error: undefined } : row))
    );
  }

  function handleRoleChange(id: string, role: UserRole) {
    setRows((previousRows) =>
      previousRows.map((row) => (row.id === id ? { ...row, role } : row))
    );
  }

  /* ── Send all invitations sequentially ───────────────── */

  async function handleSendAll() {
    const pendingRows = rows.filter(
      (row) => row.email.trim() && row.status !== "sent"
    );

    if (pendingRows.length === 0) {
      navigate("/dashboard");
      return;
    }

    setIsSendingAll(true);

    for (const inviteRow of pendingRows) {
      // Mark as sending
      setRows((previousRows) =>
        previousRows.map((row) => (row.id === inviteRow.id ? { ...row, status: "sending" } : row))
      );

      try {
        await sendInvite.mutateAsync({ email: inviteRow.email.trim(), role: inviteRow.role });
        setRows((previousRows) =>
          previousRows.map((row) => (row.id === inviteRow.id ? { ...row, status: "sent" } : row))
        );
      } catch (error) {
        const errorMessage =
          isAxiosError(error)
            ? error.response?.data?.message || "Failed to send"
            : "Failed to send";
        setRows((previousRows) =>
          previousRows.map((row) =>
            row.id === inviteRow.id ? { ...row, status: "error", error: errorMessage } : row
          )
        );
      }
    }

    setIsSendingAll(false);

    // Check if all sent successfully and redirect
    setTimeout(() => {
      setRows((currentRows) => {
        const allDone = currentRows.every(
          (row) => row.status === "sent" || !row.email.trim()
        );
        if (allDone) {
          toast.success("All invitations sent! Redirecting to dashboard…");
          setTimeout(() => navigate("/dashboard"), REDIRECT_NAVIGATE_DELAY);
        }
        return currentRows;
      });
    }, REDIRECT_CHECK_DELAY);
  }

  function handleSkip() {
    navigate("/dashboard");
  }

  /* ── Derived state ───────────────────────────────────── */

  const sentCount = rows.filter((row) => row.status === "sent").length;
  const hasValidEmails = rows.some((row) => row.email.trim() && row.status !== "sent");

  return (
    <div>


      {/* Heading */}
      <div className="mb-8 text-center pt-8">
        <h2 className="text-[38px] font-bold text-gray-900">Invite your team</h2>
        <p className="mt-1.5 text-[12px] text-gray-500">
          Collaborate across operations, support,
          marketing, and fulfillment from one workspace.
        </p>
      </div>

      {/* Invite rows card */}
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/[0.06]">
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={row.id} className="flex  gap-2 items-center ">
              {/* Email */}
              <div className="relative flex-1">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
                <input
                  type="email"
                  placeholder="teammate@company.com"
                  value={row.email}
                  onChange={(event) => handleEmailChange(row.id, event.target.value)}
                  disabled={row.status === "sent" || row.status === "sending"}
                  className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 disabled:bg-gray-50 disabled:opacity-60"
                />
                {row.status === "sent" && (
                  <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-[#084734]" />
                )}
              </div>

              {/* Role select */}
              <Select
                value={row.role}
                onValueChange={(selectedRole) => handleRoleChange(row.id, selectedRole as UserRole)}
                disabled={row.status === "sent" || row.status === "sending"}
              >
                <SelectTrigger className="w-[130px] shrink-0 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 shadow-sm focus:ring-[#CEF17B]/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((roleOption) => (
                    <SelectItem key={roleOption.value} value={roleOption.value}>
                      <div>
                        <span className="font-medium">{roleOption.label}</span>
                        <span className="ml-1.5 text-[10px] text-gray-400">{roleOption.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Remove button */}
              {rows.length > 1 && row.status !== "sent" && (
                <button
                  type="button"
                  onClick={() => handleRemoveRow(row.id)}
                  className="mt-2.5 shrink-0 text-gray-300 hover:text-gray-500 transition-colors"
                >
                  <X className="size-4" />
                </button>
              )}

              {/* Spacer if can't remove */}
              {(rows.length <= 1 || row.status === "sent") && (
                <div className="w-4 shrink-0" />
              )}
            </div>
          ))}

          {/* Error messages */}
          {rows.some((row) => row.error) && (
            <div className="space-y-1 pt-1">
              {rows
                .filter((row) => row.error)
                .map((row) => (
                  <p key={row.id} className="text-xs text-red-500">
                    {row.email}: {row.error}
                  </p>
                ))}
            </div>
          )}
        </div>

        {/* Add another */}
        <button
          type="button"
          onClick={handleAddRow}
          disabled={isSendingAll}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[#084734] hover:text-[#3d6000] transition-colors disabled:opacity-50"
        >
          <Plus className="size-4" /> Add another
        </button>

        {/* Sent counter */}
        {sentCount > 0 && (
          <p className="mt-3 text-xs text-[#084734]">
            <CheckCircle2 className="inline size-3.5 mr-1" />
            {sentCount} invitation{sentCount > 1 ? "s" : ""} sent successfully
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="mt-6 flex items-center justify-between">
        <Link
          to="/onboarding/create-organization"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="size-4" /> Back
        </Link>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSkip}
            disabled={isSendingAll}
            className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Skip for now
          </button>

          <button
            type="button"
            onClick={handleSendAll}
            disabled={isSendingAll || (!hasValidEmails && sentCount === 0)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#CEF17B] px-5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSendingAll ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Sending…
              </>
            ) : hasValidEmails ? (
              <>
                Send invitations
                <ArrowRight className="size-4" />
              </>
            ) : (
              <>
                Go to dashboard
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
