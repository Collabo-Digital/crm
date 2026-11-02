import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
    ArrowLeft,
    Building2,
    ChevronDown,
    CreditCard,
    LogIn,
    Mail,
    ShieldCheck,
    ShieldOff,
    UserCheck,
    UserX,
} from "lucide-react";
import {
    useAdminUserDetail,
    useImpersonate,
    useUserModerationMutations,
} from "~/hooks/use-admin-queries";
import { useAuthStore } from "~/stores/auth.store";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "~/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { EmptyState } from "~/components/app/empty-state";
import { OrgBillingDialog, billingSummary } from "~/components/app/admin/org-billing-dialog";
import type { AdminUserMembership } from "~/services/admin.service";

export function meta() {
    return [{ title: "Super Admin · User | Collabo CRM" }];
}

type ConfirmKind = "softDelete" | "reactivate" | "forceVerify" | "forceLogout";

const CONFIRM_LABELS: Record<
    ConfirmKind,
    { title: string; description: string; cta: string; destructive?: boolean }
> = {
    softDelete: {
        title: "Soft-delete this user?",
        description:
            "The user will no longer be able to log in. Their data is preserved and can be restored later.",
        cta: "Soft-delete",
        destructive: true,
    },
    reactivate: {
        title: "Reactivate this user?",
        description: "The user will be able to log in again.",
        cta: "Reactivate",
    },
    forceVerify: {
        title: "Force-verify this user's email?",
        description:
            "Marks the email as verified without an OTP. Use only when you can confirm the email is genuinely theirs.",
        cta: "Verify email",
    },
    forceLogout: {
        title: "Force-logout this user?",
        description:
            "Revokes every active session and refresh token. They'll need to log in again on every device.",
        cta: "Force-logout",
        destructive: true,
    },
};

/**
 * Super-admin user detail page.
 *
 * - Profile snapshot + memberships
 * - "Log in as this user" → org picker → impersonation start
 * - Moderation actions behind a confirm dialog
 */
export default function UserDetailPage() {
    const { userId = "" } = useParams();
    const { user: me, impersonatedBy } = useAuthStore();
    const navigate = useNavigate();

    const { data: user, isLoading } = useAdminUserDetail(userId);
    const impersonate = useImpersonate();
    const moderation = useUserModerationMutations(userId);
    const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
    const [billingFor, setBillingFor] = useState<AdminUserMembership | null>(null);

    if (!me?.isSuperAdmin || impersonatedBy) {
        return (
            <EmptyState
                icon={ShieldCheck}
                title="Not authorized"
                description="This area is only available to the Collabo team."
                action={<Button onClick={() => navigate("/dashboard")}>Back to dashboard</Button>}
            />
        );
    }

    if (isLoading) {
        return <div className="p-8 text-center text-gray-500">Loading user...</div>;
    }
    if (!user) {
        return (
            <EmptyState
                title="User not found"
                action={<Button onClick={() => navigate("/admin/users")}>Back to users</Button>}
            />
        );
    }

    const canImpersonate = !user.deletedAt && !user.isSuperAdmin;

    /** Type-safe dispatcher: maps a confirm kind to the matching mutation. */
    const runConfirm = () => {
        if (!confirm) return;
        moderation[confirm].mutate();
        setConfirm(null);
    };

    return (
        <div className="space-y-6">
            <Button variant="ghost" size="sm" asChild>
                <Link to="/admin/users" className="flex items-center gap-1">
                    <ArrowLeft className="size-4" />
                    Back
                </Link>
            </Button>

            {/* Profile */}
            <section className="rounded-xl border bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                        <Avatar size="lg">
                            <AvatarImage src={user.avatarUrl ?? ""} />
                            <AvatarFallback className="bg-[#CEF17B] text-base font-bold text-gray-900">
                                {user.firstName[0]}
                                {user.lastName[0]}
                            </AvatarFallback>
                        </Avatar>
                        <div>
                            <h1 className="text-2xl font-bold">
                                {user.firstName} {user.lastName}
                            </h1>
                            <p className="text-gray-500">{user.email}</p>
                            <div className="mt-2 flex items-center gap-2">
                                {user.deletedAt ? (
                                    <Badge variant="destructive">Deleted</Badge>
                                ) : (
                                    <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                                        Active
                                    </Badge>
                                )}
                                {user.isSuperAdmin && (
                                    <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100">
                                        Super Admin
                                    </Badge>
                                )}
                                {user.emailVerified ? (
                                    <Badge variant="secondary">Email verified</Badge>
                                ) : (
                                    <Badge variant="outline">Email pending</Badge>
                                )}
                            </div>
                        </div>
                    </div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button disabled={!canImpersonate || impersonate.isPending}>
                                <LogIn className="size-4" />
                                {impersonate.isPending ? "Starting..." : "Log in as this user"}
                                <ChevronDown className="size-3.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-72">
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                                Choose organization to enter
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {user.memberships.length === 0 ? (
                                <DropdownMenuItem
                                    onClick={() => impersonate.mutate({ userId: user.id })}
                                >
                                    No organization (user-only session)
                                </DropdownMenuItem>
                            ) : (
                                user.memberships.map((m) => (
                                    <DropdownMenuItem
                                        key={m.organizationId}
                                        onClick={() =>
                                            impersonate.mutate({
                                                userId: user.id,
                                                orgId: m.organizationId,
                                            })
                                        }
                                        disabled={!m.isActive}
                                    >
                                        <div className="flex w-full items-center justify-between gap-2">
                                            <span>{m.orgName}</span>
                                            <Badge variant="outline" className="text-[10px]">
                                                {m.role}
                                            </Badge>
                                        </div>
                                    </DropdownMenuItem>
                                ))
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                {!canImpersonate && (
                    <p className="mt-4 text-xs text-gray-500">
                        {user.deletedAt
                            ? "Impersonation is disabled for soft-deleted users."
                            : "Impersonation is disabled for super admin accounts."}
                    </p>
                )}

                <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-3 border-t pt-4 text-sm md:grid-cols-4">
                    <div>
                        <dt className="text-xs text-gray-500">2FA</dt>
                        <dd className="font-medium">
                            {user.twoFactorEnabled ? "Enabled" : "Disabled"}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs text-gray-500">Last login</dt>
                        <dd className="font-medium">
                            {user.lastLoginAt
                                ? new Date(user.lastLoginAt).toLocaleString()
                                : "Never"}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs text-gray-500">Joined</dt>
                        <dd className="font-medium">
                            {new Date(user.createdAt).toLocaleDateString()}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs text-gray-500">Email verified at</dt>
                        <dd className="font-medium">
                            {user.emailVerifiedAt
                                ? new Date(user.emailVerifiedAt).toLocaleDateString()
                                : "—"}
                        </dd>
                    </div>
                </dl>
            </section>

            {/* Organizations */}
            <section className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold">
                    Organizations ({user.memberships.length})
                </h2>
                {user.memberships.length === 0 ? (
                    <EmptyState
                        icon={Building2}
                        title="No organizations"
                        description="This user hasn't joined any workspace yet."
                    />
                ) : (
                    <ul className="divide-y">
                        {user.memberships.map((m) => (
                            <li
                                key={m.organizationId}
                                className="flex items-center justify-between py-3 text-sm"
                            >
                                <div>
                                    <p className="font-medium">{m.orgName}</p>
                                    <p className="text-xs text-gray-500">
                                        {m.orgSlug} · {m.orgType}
                                    </p>
                                    <p className="text-xs text-gray-500">{billingSummary(m.billing)}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline">{m.role}</Badge>
                                    {!m.isActive && (
                                        <Badge variant="secondary" className="text-[10px]">
                                            inactive
                                        </Badge>
                                    )}
                                    <Button variant="outline" size="sm" onClick={() => setBillingFor(m)}>
                                        <CreditCard className="size-4" />
                                        Set plan or trial
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* Moderation */}
            <section className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="mb-1 text-lg font-semibold">Moderation</h2>
                <p className="mb-4 text-xs text-gray-500">
                    These actions affect the live user. Each one requires confirmation.
                </p>
                <div className="flex flex-wrap gap-2">
                    {user.deletedAt ? (
                        <Button variant="outline" onClick={() => setConfirm("reactivate")}>
                            <UserCheck className="size-4" />
                            Reactivate
                        </Button>
                    ) : (
                        <Button variant="destructive" onClick={() => setConfirm("softDelete")}>
                            <UserX className="size-4" />
                            Soft-delete
                        </Button>
                    )}
                    {!user.emailVerified && (
                        <Button variant="outline" onClick={() => setConfirm("forceVerify")}>
                            <Mail className="size-4" />
                            Force-verify email
                        </Button>
                    )}
                    <Button variant="outline" onClick={() => setConfirm("forceLogout")}>
                        <ShieldOff className="size-4" />
                        Force-logout
                    </Button>
                </div>
            </section>

            {billingFor && <OrgBillingDialog userId={user.id} membership={billingFor} onClose={() => setBillingFor(null)} />}

            <Dialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
                <DialogContent>
                    {confirm && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{CONFIRM_LABELS[confirm].title}</DialogTitle>
                                <DialogDescription>
                                    {CONFIRM_LABELS[confirm].description}
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setConfirm(null)}>
                                    Cancel
                                </Button>
                                <Button
                                    variant={
                                        CONFIRM_LABELS[confirm].destructive ? "destructive" : "default"
                                    }
                                    onClick={runConfirm}
                                    disabled={moderation[confirm].isPending}
                                >
                                    {moderation[confirm].isPending
                                        ? "Working..."
                                        : CONFIRM_LABELS[confirm].cta}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
