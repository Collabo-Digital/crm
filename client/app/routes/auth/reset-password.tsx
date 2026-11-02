import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2, KeyRound, ArrowLeft } from "lucide-react";

import { useResetPasswordMutation } from "~/hooks/use-auth-mutations";
import { Button } from "~/components/ui/button";

export function meta() {
  return [
    { title: "Reset Password | Collabo CRM" },
    { name: "description", content: "Set a new password for your account" },
  ];
}

const resetPasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

/**
 * Reset password page where users set a new password using a token from email.
 * Validates that both password fields match and enforces minimum length.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const reset = useResetPasswordMutation();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const serverError =
    reset.error && isAxiosError(reset.error)
      ? reset.error.response?.data?.message
      : null;

  function onSubmit(data: ResetPasswordFormValues) {
    reset.mutate({ token, newPassword: data.newPassword });
  }

  /* ── Invalid / missing token ── */
  if (!token) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-danger-subtle">
          <KeyRound className="size-6 text-danger" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Invalid link</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This reset link is missing or invalid. Please request a new one.
        </p>
        <Link
          to="/auth/forgot-password"
          className="mt-6 inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-brand-foreground shadow-sm transition hover:bg-brand-hover"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Heading */}
      <div className="mb-7">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand/30">
          <KeyRound className="size-5 text-brand-strong" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Set a new password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Choose a strong password you haven't used before.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* New password */}
        <div className="space-y-1.5">
          <label htmlFor="newPassword" className="block text-sm font-medium text-foreground">
            New password
          </label>
          <div className="relative">
            <input
              id="newPassword"
              type={showNewPassword ? "text" : "password"}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              aria-invalid={!!errors.newPassword}
              aria-describedby={errors.newPassword ? "newPassword-error" : undefined}
              {...register("newPassword")}
              className="h-11 w-full rounded-lg border border-input bg-card px-3.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <button
              type="button"
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowNewPassword((visible) => !visible)}
              aria-label={showNewPassword ? "Hide password" : "Show password"}
            >
              {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.newPassword && (
            <p id="newPassword-error" className="text-xs text-danger-text">{errors.newPassword.message}</p>
          )}
        </div>

        {/* Confirm password */}
        <div className="space-y-1.5">
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground">
            Confirm new password
          </label>
          <div className="relative">
            <input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Re-enter your password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmPassword}
              aria-describedby={errors.confirmPassword ? "confirmPassword-error" : undefined}
              {...register("confirmPassword")}
              className="h-11 w-full rounded-lg border border-input bg-card px-3.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <button
              type="button"
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowConfirmPassword((visible) => !visible)}
              aria-label={showConfirmPassword ? "Hide password" : "Show password"}
            >
              {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.confirmPassword && (
            <p id="confirmPassword-error" className="text-xs text-danger-text">{errors.confirmPassword.message}</p>
          )}
        </div>

        {/* Password hints */}
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>• At least 8 characters long</li>
          <li>• Mix of letters, numbers, and symbols recommended</li>
        </ul>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-sm text-danger-text">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <Button type="submit" size="lg" disabled={reset.isPending} className="h-11 w-full font-semibold">
          {reset.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Resetting password…
            </>
          ) : (
            "Reset password"
          )}
        </Button>
      </form>

      {/* Back */}
      <div className="mt-6 flex justify-center">
        <Link
          to="/auth/login"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Back to sign in
        </Link>
      </div>
    </div>
  );
}
