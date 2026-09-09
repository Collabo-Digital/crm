import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import {
  Eye, EyeOff, Loader2, Users, AlertCircle, CheckCircle2,
} from "lucide-react";

import { authService } from "~/services/auth.service";
import { useAuthStore } from "~/stores/auth.store";
import { useAcceptInviteMutation } from "~/hooks/use-auth-mutations";

export function meta() {
  return [
    { title: "Join Team | Collabo CRM" },
    { name: "description", content: "Accept your team invitation" },
  ];
}

const newUserSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(50),
  lastName: z.string().min(1, "Last name is required").max(50),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type NewUserForm = z.infer<typeof newUserSchema>;

/**
 * Invitation acceptance page for users invited to join an organization.
 * Handles both existing users (one-click accept) and new users (account creation form).
 */
export default function InvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [showPassword, setShowPassword] = useState(false);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authEmail = useAuthStore((state) => state.user?.email);

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => authService.getInvite(token),
    enabled: !!token,
    retry: false,
  });

  const accept = useAcceptInviteMutation();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<NewUserForm>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { firstName: "", lastName: "", password: "" },
  });

  const serverError =
    accept.error && isAxiosError(accept.error)
      ? accept.error.response?.data?.message
      : null;

  const inviteError =
    invite.error && isAxiosError(invite.error)
      ? invite.error.response?.data?.message
      : invite.error
        ? "Failed to load invitation."
        : null;

  /* Existing user — just accept */
  function handleAcceptExisting() {
    accept.mutate({ token });
  }

  /* New user — accept with credentials */
  function onSubmitNewUser(data: NewUserForm) {
    accept.mutate({ token, ...data });
  }

  /* ── No token ── */
  if (!token) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-100">
          <AlertCircle className="size-6 text-red-500" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Invalid invite link</h2>
        <p className="mt-2 text-sm text-gray-500">
          This invitation link is missing or broken.
        </p>
        <Link
          to="/auth/login"
          className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-[#CEF17B] px-5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F]"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  /* ── Loading invite details ── */
  if (invite.isLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="size-8 animate-spin text-[#084734]" />
        <p className="text-sm text-gray-500">Loading invitation…</p>
      </div>
    );
  }

  /* ── Error loading invite ── */
  if (inviteError || !invite.data) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-100">
          <AlertCircle className="size-6 text-red-500" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Invite not found</h2>
        <p className="mt-2 text-sm text-gray-500">
          {inviteError || "This invitation may have expired or already been used."}
        </p>
        <Link
          to="/auth/login"
          className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-[#CEF17B] px-5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F]"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  const { email, role, organization, userExists } = invite.data;
  const isInfluencer = role === "INFLUENCER";
  const roleLabel = isInfluencer ? "influencer" : role.toLowerCase();
  // "an influencer", "an admin", "an agent" — every other role takes "a".
  const roleArticle = /^[aeiou]/.test(roleLabel) ? "an" : "a";
  // Signing in as the invited person is now required to claim an invitation
  // addressed to an existing account — holding the link is not proof of
  // ownership. Send them to login and back.
  const signInHref = `/auth/login?next=${encodeURIComponent(`/auth/invite?token=${token}`)}`;
  const mustSignIn = userExists && !isAuthenticated;
  const wrongAccount = userExists && isAuthenticated && authEmail !== email;

  /* ── Invite loaded ── */
  return (
    <div>
      {/* Header */}
      <div className="mb-7 text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <Users className="size-6 text-[#084734]" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">You're invited!</h2>
        <p className="mt-2 text-sm text-gray-500">
          You've been invited to join{" "}
          <span className="font-semibold text-gray-700">{organization.name}</span>
          {" "}as {roleArticle}{" "}
          <span className="font-semibold text-gray-700">{roleLabel}</span>.
        </p>
      </div>

      {/* Org card */}
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-5 py-4 shadow-sm">
        {organization.logo ? (
          <img src={organization.logo} alt="" className="size-10 rounded-xl object-cover" />
        ) : (
          <div className="flex size-10 items-center justify-center rounded-xl bg-[#CEF17B]/30 text-sm font-bold text-[#084734]">
            {organization.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-gray-900">{organization.name}</p>
          <p className="text-xs text-gray-400">Invited as {roleLabel}</p>
        </div>
      </div>

      {/* Invited email */}
      <div className="mb-5 rounded-lg bg-gray-50 px-4 py-3">
        <p className="text-xs text-gray-400">Invitation sent to</p>
        <p className="text-sm font-medium text-gray-700">{email}</p>
      </div>

      {wrongAccount ? (
        /* ── Signed in as somebody else ── */
        <div>
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-600">
              This invitation was sent to {email}, but you are signed in as{" "}
              {authEmail}. Sign out and open the invitation link again to accept it.
            </p>
          </div>
          <Link
            to="/auth/login"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F]"
          >
            Go to sign in
          </Link>
        </div>
      ) : mustSignIn ? (
        /* ── Existing account: prove it is yours before joining it ── */
        <div>
          <p className="mb-4 text-sm text-gray-500">
            An account already exists for this address. Sign in to accept the
            invitation — you will come straight back here.
          </p>
          <Link
            to={signInHref}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F]"
          >
            Sign in to accept
          </Link>
        </div>
      ) : userExists ? (
        /* ── Existing user, signed in as them: just accept ── */
        <div>
          <p className="mb-4 text-sm text-gray-500">
            {isInfluencer
              ? "Join this organization to connect your Instagram account and start collaborating."
              : "You already have a Collabo account. Click below to join this workspace."}
          </p>

          {serverError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm text-red-600">{serverError}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handleAcceptExisting}
            disabled={accept.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {accept.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Joining…
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4" />
                Accept &amp; join {organization.name}
              </>
            )}
          </button>
        </div>
      ) : (
        /* ── New user: create account + accept ── */
        <div>
          <p className="mb-4 text-sm text-gray-500">
            Create your account to join this workspace.
          </p>

          <form onSubmit={handleSubmit(onSubmitNewUser)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="firstName" className="block text-sm font-medium text-gray-700">
                  First name
                </label>
                <input
                  id="firstName"
                  placeholder="John"
                  autoComplete="given-name"
                  aria-invalid={!!errors.firstName}
                  {...register("firstName")}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
                />
                {errors.firstName && (
                  <p className="text-xs text-red-500">{errors.firstName.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="lastName" className="block text-sm font-medium text-gray-700">
                  Last name
                </label>
                <input
                  id="lastName"
                  placeholder="Doe"
                  autoComplete="family-name"
                  aria-invalid={!!errors.lastName}
                  {...register("lastName")}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
                />
                {errors.lastName && (
                  <p className="text-xs text-red-500">{errors.lastName.message}</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                  aria-invalid={!!errors.password}
                  {...register("password")}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 pr-10 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  onClick={() => setShowPassword((visible) => !visible)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="text-xs text-red-500">{errors.password.message}</p>
              )}
            </div>

            {serverError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-sm text-red-600">{serverError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={accept.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {accept.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                "Create account & join"
              )}
            </button>
          </form>
        </div>
      )}

      {/* Footer */}
      <p className="mt-6 text-center text-xs text-gray-400">
        Already have an account?{" "}
        <Link
          to="/auth/login"
          className="font-semibold text-[#084734] hover:text-[#3d6000] transition-colors"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
