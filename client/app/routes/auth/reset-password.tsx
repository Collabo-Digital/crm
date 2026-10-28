import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2, KeyRound, ArrowLeft } from "lucide-react";

import { useResetPasswordMutation } from "~/hooks/use-auth-mutations";

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
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-100">
          <KeyRound className="size-6 text-red-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Invalid link</h1>
        <p className="mt-2 text-sm text-gray-500">
          This reset link is missing or invalid. Please request a new one.
        </p>
        <Link
          to="/auth/forgot-password"
          className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-[#CEF17B] px-5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F]"
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
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <KeyRound className="size-5 text-[#084734]" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Set a new password</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          Choose a strong password you haven't used before.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* New password */}
        <div className="space-y-1.5">
          <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700">
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
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 pr-10 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition aria-[invalid=true]:border-red-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <button
              type="button"
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 hover:text-gray-700 transition-colors"
              onClick={() => setShowNewPassword((visible) => !visible)}
              aria-label={showNewPassword ? "Hide password" : "Show password"}
            >
              {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.newPassword && (
            <p id="newPassword-error" className="text-xs text-red-700">{errors.newPassword.message}</p>
          )}
        </div>

        {/* Confirm password */}
        <div className="space-y-1.5">
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
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
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 pr-10 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition aria-[invalid=true]:border-red-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
            <button
              type="button"
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 hover:text-gray-700 transition-colors"
              onClick={() => setShowConfirmPassword((visible) => !visible)}
              aria-label={showConfirmPassword ? "Hide password" : "Show password"}
            >
              {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.confirmPassword && (
            <p id="confirmPassword-error" className="text-xs text-red-700">{errors.confirmPassword.message}</p>
          )}
        </div>

        {/* Password hints */}
        <ul className="space-y-1 text-xs text-gray-400">
          <li>• At least 8 characters long</li>
          <li>• Mix of letters, numbers, and symbols recommended</li>
        </ul>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-600">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={reset.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {reset.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Resetting password…
            </>
          ) : (
            "Reset password"
          )}
        </button>
      </form>

      {/* Back */}
      <div className="mt-6 flex justify-center">
        <Link
          to="/auth/login"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Back to sign in
        </Link>
      </div>
    </div>
  );
}
