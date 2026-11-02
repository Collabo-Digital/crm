import { useState, useEffect, type FormEvent } from "react";
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
import { signOut } from "~/lib/sign-out";
import { Button } from "~/components/ui/button";

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
  const [existingPassword, setExistingPassword] = useState("");
  const [signingOut, setSigningOut] = useState(false);
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

  /* Existing user — signed in as the invitee, or confirming with their password */
  function handleAcceptExisting(event: FormEvent) {
    event.preventDefault();
    accept.mutate(isAuthenticated ? { token } : { token, password: existingPassword });
  }

  /* New user — accept with credentials */
  function onSubmitNewUser(data: NewUserForm) {
    accept.mutate({ token, ...data });
  }

  /* ── No token ── */
  if (!token) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-danger-subtle">
          <AlertCircle className="size-6 text-danger" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Invalid invite link</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This invitation link is missing or broken.
        </p>
        <Link
          to="/auth/login"
          className="mt-6 inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-brand-foreground shadow-sm transition hover:bg-brand-hover"
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
        <Loader2 className="size-8 animate-spin text-brand-strong" />
        <p className="text-sm text-muted-foreground">Loading invitation…</p>
      </div>
    );
  }

  /* ── Error loading invite ── */
  if (inviteError || !invite.data) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-danger-subtle">
          <AlertCircle className="size-6 text-danger" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Invite not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {inviteError || "This invitation may have expired or already been used."}
        </p>
        <Link
          to="/auth/login"
          className="mt-6 inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-brand-foreground shadow-sm transition hover:bg-brand-hover"
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
  // Holding the link is not proof of owning an existing account: the server
  // accepts it only for that account signed in, or with its password. A new
  // invitee must not sign up on top of someone else's session either.
  const wrongAccount = isAuthenticated && authEmail?.toLowerCase() !== email.toLowerCase();

  /* Sign out here, staying on this page to accept as the invitee */
  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    setSigningOut(false);
  }

  /* ── Invite loaded ── */
  return (
    <div>
      {/* Header */}
      <div className="mb-7 text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand/30">
          <Users className="size-6 text-brand-strong" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">You're invited!</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You've been invited to join{" "}
          <span className="font-semibold text-foreground">{organization.name}</span>
          {" "}as {roleArticle}{" "}
          <span className="font-semibold text-foreground">{roleLabel}</span>.
        </p>
      </div>

      {/* Org card */}
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
        {organization.logo ? (
          <img src={organization.logo} alt="" className="size-10 rounded-xl object-cover" />
        ) : (
          <div className="flex size-10 items-center justify-center rounded-xl bg-brand/30 text-sm font-bold text-brand-strong">
            {organization.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-foreground">{organization.name}</p>
          <p className="text-xs text-muted-foreground">Invited as {roleLabel}</p>
        </div>
      </div>

      {/* Invited email */}
      <div className="mb-5 rounded-lg bg-gray-50 px-4 py-3">
        <p className="text-xs text-muted-foreground">Invitation sent to</p>
        <p className="text-sm font-medium text-foreground">{email}</p>
      </div>

      {wrongAccount ? (
        /* ── Signed in as somebody else ── */
        <div>
          <div className="mb-4 rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-sm text-danger-text">
              This invitation was sent to {email}, but you are signed in as{" "}
              {authEmail}. Sign out to accept it as {email}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingOut && <Loader2 className="size-4 animate-spin" />}
            Sign out of {authEmail}
          </button>
        </div>
      ) : userExists ? (
        /* ── Existing account: signed in as them, or confirm with their password ── */
        <form onSubmit={handleAcceptExisting}>
          <p className="mb-4 text-sm text-muted-foreground">
            {isInfluencer
              ? "Join this organization to connect your Instagram account and start collaborating."
              : isAuthenticated
                ? "You already have a Collabo account. Click below to join this workspace."
                : "You already have a Collabo account. Enter your password to join this workspace."}
          </p>

          {!isAuthenticated && (
            <div className="mb-4 space-y-1.5">
              <label htmlFor="existingPassword" className="block text-sm font-medium text-foreground">
                Password
              </label>
              <input
                id="existingPassword"
                type="password"
                autoComplete="current-password"
                required
                value={existingPassword}
                onChange={(event) => setExistingPassword(event.target.value)}
                className="h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
              />
            </div>
          )}

          {serverError && (
            <div role="alert" className="mb-4 rounded-lg bg-danger-subtle px-4 py-3">
              <p className="text-sm text-danger-text">{serverError}</p>
            </div>
          )}

          <Button type="submit" size="lg" disabled={accept.isPending} className="h-11 w-full font-semibold">
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
          </Button>
        </form>
      ) : (
        /* ── New user: create account + accept ── */
        <div>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your account to join this workspace.
          </p>

          <form onSubmit={handleSubmit(onSubmitNewUser)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="firstName" className="block text-sm font-medium text-foreground">
                  First name
                </label>
                <input
                  id="firstName"
                  placeholder="John"
                  autoComplete="given-name"
                  aria-invalid={!!errors.firstName}
                  aria-describedby={errors.firstName ? "firstName-error" : undefined}
                  {...register("firstName")}
                  className="h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
                {errors.firstName && (
                  <p id="firstName-error" className="text-xs text-danger-text">{errors.firstName.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="lastName" className="block text-sm font-medium text-foreground">
                  Last name
                </label>
                <input
                  id="lastName"
                  placeholder="Doe"
                  autoComplete="family-name"
                  aria-invalid={!!errors.lastName}
                  aria-describedby={errors.lastName ? "lastName-error" : undefined}
                  {...register("lastName")}
                  className="h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
                {errors.lastName && (
                  <p id="lastName-error" className="text-xs text-danger-text">{errors.lastName.message}</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-foreground">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                  aria-invalid={!!errors.password}
                  aria-describedby={errors.password ? "password-error" : undefined}
                  {...register("password")}
                  className="h-11 w-full rounded-lg border border-input bg-card px-3.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
                <button
                  type="button"
                  className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {errors.password && (
                <p id="password-error" className="text-xs text-danger-text">{errors.password.message}</p>
              )}
            </div>

            {serverError && (
              <div role="alert" className="rounded-lg bg-danger-subtle px-4 py-3">
                <p className="text-sm text-danger-text">{serverError}</p>
              </div>
            )}

            <Button type="submit" size="lg" disabled={accept.isPending} className="h-11 w-full font-semibold">
              {accept.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                "Create account & join"
              )}
            </Button>
          </form>
        </div>
      )}

      {/* Footer */}
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link
          to="/auth/login"
          className="font-semibold text-brand-strong hover:text-brand-strong-hover transition-colors"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
