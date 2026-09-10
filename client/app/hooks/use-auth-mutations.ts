import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { isAxiosError } from "axios";
import { authService } from "~/services/auth.service";
import { useAuthStore } from "~/stores/auth.store";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { defaultGrantsForRole } from "~/lib/permissions";
import type {
  SignupRequest,
  LoginRequest,
  VerifyEmailRequest,
  ResendVerificationRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  AcceptInviteRequest,
} from "~/types/api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolvePostAuthRoute(nextStep: string | null): string {
  if (nextStep !== "choose-plan") return "/dashboard";
  // Users who pick a plan but close the tab before creating their org can log
  // back in without re-picking — skip ahead to account-type.
  const { pendingPlan } = useAuthStore.getState();
  return pendingPlan ? "/onboarding/account-type" : "/onboarding/choose-plan";
}

// ─── Signup ──────────────────────────────────────────────────────────────────

/** Mutation hook for new user registration. Navigates to email verification on success. */
export function useSignupMutation() {
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (data: SignupRequest) => authService.signup(data),
    onSuccess: (data) => {
      toast.success("Account created! Please verify your email.");
      navigate(`/auth/verify-email?userId=${data.userId}`);
    },
    onError: (error) => handleMutationError(error),
  });
}

// ─── Login ───────────────────────────────────────────────────────────────────

/** Mutation hook for user login. Sets auth state and navigates to the appropriate post-auth route. */
/**
 * Where to go after signing in, honouring a `next` the caller asked for.
 *
 * Only same-site paths are accepted: an absolute URL or a protocol-relative
 * `//evil.example` would turn our own login into an open redirect.
 */
function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function useLoginMutation(next?: string | null) {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  return useMutation({
    mutationFn: (data: LoginRequest) => authService.login(data),
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken, data.refreshToken, data.organizations);
      // Backend returns flat orgs: { id, name, slug, type, role }
      // setAuth normalizes them — use the org id directly
      if (data.organizations.length > 0) {
        useAuthStore.getState().setCurrentOrg(data.organizations[0].id);
      }
      // An invitation sends people here to prove who they are, then expects
      // them back. Without this the token is lost at the login screen and the
      // invitation looks broken.
      navigate(safeNext(next) ?? resolvePostAuthRoute(data.nextStep));
    },
    onError: (error) => {
      if (isAxiosError(error)) {
        // 403 = email not verified → redirect to OTP page
        if (error.response?.status === 403) {
          const userId = error.response.data?.userId;
          if (userId) {
            toast.info("Please verify your email first.");
            navigate(`/auth/verify-email?userId=${userId}`);
            return;
          }
        }
        // Show server error message (e.g. "Invalid email or password")
        const msg = error.response?.data?.message;
        if (msg) {
          toast.error(msg);
        }
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    },
  });
}

// ─── Email Verification ─────────────────────────────────────────────────────

/** Mutation hook for email verification via OTP code. Sets auth state on success. */
export function useVerifyEmailMutation() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  return useMutation({
    mutationFn: (data: VerifyEmailRequest) => authService.verifyEmail(data),
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken, data.refreshToken, data.organizations);
      // Backend returns flat orgs: { id, name, slug, type, role }
      if (data.organizations.length > 0) {
        useAuthStore.getState().setCurrentOrg(data.organizations[0].id);
      }
      toast.success("Email verified successfully!");
      navigate(resolvePostAuthRoute(data.nextStep));
    },
    onError: (error) => handleMutationError(error),
  });
}

/** Mutation hook for resending the email verification code. */
export function useResendVerificationMutation() {
  return useMutation({
    mutationFn: (data: ResendVerificationRequest) =>
      authService.resendVerification(data),
    onSuccess: () => {
      toast.success("Verification code resent to your email.");
    },
    onError: (error) => handleMutationError(error, "Failed to resend code."),
  });
}

// ─── Password Reset ─────────────────────────────────────────────────────────

/** Mutation hook for requesting a password reset email. */
export function useForgotPasswordMutation() {
  return useMutation({
    mutationFn: (data: ForgotPasswordRequest) =>
      authService.forgotPassword(data),
    onError: (error) => handleMutationError(error),
  });
}

/** Mutation hook for setting a new password via reset token. Navigates to login on success. */
export function useResetPasswordMutation() {
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (data: ResetPasswordRequest) =>
      authService.resetPassword(data),
    onSuccess: () => {
      toast.success("Password reset successfully. You can now sign in.");
      navigate("/auth/login");
    },
    onError: (error) => handleMutationError(error),
  });
}

// ─── Invite Accept ──────────────────────────────────────────────────────────

/** Mutation hook for accepting a team invitation. Creates a session and navigates to dashboard. */
export function useAcceptInviteMutation() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const existingOrgs = useAuthStore((s) => s.organizations);
  const existingUser = useAuthStore((s) => s.user);

  return useMutation({
    mutationFn: (data: AcceptInviteRequest) =>
      authService.acceptInvite(data),
    onSuccess: (data) => {
      // Build user from response (use existing user data if available for richer profile)
      const user = existingUser
        ? { ...existingUser, ...data.user }
        : {
            id: data.user.id,
            email: data.user.email,
            firstName: data.user.firstName,
            lastName: data.user.lastName,
            avatarUrl: null,
            emailVerified: true,
            twoFactorEnabled: false,
            lastLoginAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

      // Build org membership from the invite response.
      //
      // The role comes from the response, not a guess. It was hardcoded to
      // AGENT, so an accepted invitation to any other role put the wrong one in
      // the store and every role check downstream — the navigation, the
      // channels page, the route guards — read it until the next full reload.
      const invitedOrgMembership = {
        id: crypto.randomUUID(),
        organizationId: data.organization.id,
        role: data.role,
        permissions: defaultGrantsForRole(data.role),
        isActive: true,
        organization: {
          id: data.organization.id,
          name: data.organization.name,
          slug: data.organization.slug,
          type: "ORGANIZATION" as const,
          logo: null,
          timezone: "UTC",
          currency: "USD",
          industry: null,
          website: null,
          billingPlan: "BASIC" as const,
          billingInterval: null,
          onboardingStatus: "COMPLETED" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      // Merge with existing orgs (don't replace — user may already belong to other orgs)
      const alreadyHasOrg = existingOrgs.some(
        (o) => o.organization.id === data.organization.id,
      );
      const mergedOrgs = alreadyHasOrg
        ? existingOrgs
        : [...existingOrgs, invitedOrgMembership];

      setAuth(user, data.accessToken, data.refreshToken, mergedOrgs);
      useAuthStore.getState().setCurrentOrg(data.organization.id);
      toast.success(`Joined ${data.organization.name} successfully!`);
      // An influencer has no dashboard: it is one of the sections their role
      // cannot reach, so landing there would bounce them straight out again.
      // Send them where their work actually starts.
      navigate(data.role === "INFLUENCER" ? "/settings/channels" : "/dashboard");
    },
    onError: (error) => handleMutationError(error),
  });
}
