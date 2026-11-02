import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { adminService, type SetOrgBillingRequest } from "~/services/admin.service";
import { useAuthStore } from "~/stores/auth.store";

export const adminKeys = {
    all: ["admin"] as const,
    users: (params: { page: number; limit?: number; search?: string }) =>
        [...adminKeys.all, "users", params] as const,
    user: (userId: string) => [...adminKeys.all, "user", userId] as const,
};

/** Paginated + searchable list of every registered user. */
export function useAdminUsers(params: { page: number; limit?: number; search?: string }) {
    return useQuery({
        queryKey: adminKeys.users(params),
        queryFn: () => adminService.listUsers(params),
        // The previous page stays on screen, dimmed, while the next one loads.
        placeholderData: keepPreviousData,
    });
}

/** Single user detail with memberships. */
export function useAdminUserDetail(userId: string | undefined) {
    return useQuery({
        queryKey: adminKeys.user(userId ?? ""),
        queryFn: () => adminService.getUser(userId!),
        enabled: !!userId,
    });
}

/**
 * Start an impersonation session. Swaps the JWT for the target user's, then
 * hard-reloads to /dashboard so every React Query cache + memo is flushed.
 */
export function useImpersonate() {
    const { setAuth, setCurrentOrg, setImpersonation } = useAuthStore();

    return useMutation({
        mutationFn: ({ userId, orgId }: { userId: string; orgId?: string }) =>
            adminService.impersonate(userId, orgId),
        onSuccess: (data) => {
            setAuth(data.user, data.accessToken, data.refreshToken, data.organizations);
            if (data.currentOrganization) setCurrentOrg(data.currentOrganization.id);
            setImpersonation(data.impersonatedBy);
            toast.success(`Now impersonating ${data.user.firstName} ${data.user.lastName}.`);
            window.location.href = "/dashboard";
        },
        onError: (error) => handleMutationError(error, "Failed to start impersonation."),
    });
}

/** Terminate impersonation and restore the super admin's own token. */
export function useStopImpersonating() {
    const { setAuth, setCurrentOrg, setImpersonation } = useAuthStore();

    return useMutation({
        mutationFn: () => adminService.stopImpersonating(),
        onSuccess: (data) => {
            setAuth(data.user, data.accessToken, data.refreshToken, data.organizations);
            if (data.currentOrganization) setCurrentOrg(data.currentOrganization.id);
            else if (data.organizations[0]) setCurrentOrg(data.organizations[0].id);
            setImpersonation(null);
            toast.success("Switched back to your account.");
            window.location.href = "/admin/users";
        },
        onError: (error) =>
            handleMutationError(error, "Failed to switch back. Try logging out and back in."),
    });
}

/** Soft-delete / reactivate / force-verify / force-logout — bundled per-user. */
export function useUserModerationMutations(userId: string) {
    const queryClient = useQueryClient();
    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: adminKeys.user(userId) });
        queryClient.invalidateQueries({ queryKey: [...adminKeys.all, "users"] });
    };

    return {
        softDelete: useMutation({
            mutationFn: () => adminService.softDelete(userId),
            onSuccess: () => {
                toast.success("User soft-deleted.");
                invalidate();
            },
            onError: (error) => handleMutationError(error, "Failed to soft-delete user."),
        }),
        reactivate: useMutation({
            mutationFn: () => adminService.reactivate(userId),
            onSuccess: () => {
                toast.success("User reactivated.");
                invalidate();
            },
            onError: (error) => handleMutationError(error, "Failed to reactivate user."),
        }),
        forceVerify: useMutation({
            mutationFn: () => adminService.forceVerifyEmail(userId),
            onSuccess: () => {
                toast.success("Email marked verified.");
                invalidate();
            },
            onError: (error) => handleMutationError(error, "Failed to force-verify email."),
        }),
        forceLogout: useMutation({
            mutationFn: () => adminService.forceLogout(userId),
            onSuccess: () => {
                toast.success("All sessions revoked.");
                invalidate();
            },
            onError: (error) => handleMutationError(error, "Failed to revoke sessions."),
        }),
    };
}

/** Set plan / extend trial for one workspace, from a member's page. */
export function useSetOrgBilling(userId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ orgId, body }: { orgId: string; body: SetOrgBillingRequest }) => adminService.setOrgBilling(orgId, body),
        onSuccess: () => {
            toast.success("Billing updated.");
            void queryClient.invalidateQueries({ queryKey: adminKeys.user(userId) });
        },
        onError: (error) => handleMutationError(error, "Billing was not updated."),
    });
}
