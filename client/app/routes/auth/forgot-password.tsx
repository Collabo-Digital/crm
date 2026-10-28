import { useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";

import { useForgotPasswordMutation } from "~/hooks/use-auth-mutations";

export function meta() {
  return [
    { title: "Forgot Password | Collabo CRM" },
    { name: "description", content: "Reset your Collabo CRM password" },
  ];
}

const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

/**
 * Forgot password page that sends a password reset link to the user's email.
 * Shows a success confirmation view after the link has been sent.
 */
export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  const forgot = useForgotPasswordMutation();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const serverError =
    forgot.error && isAxiosError(forgot.error)
      ? forgot.error.response?.data?.message
      : null;

  function onSubmit(data: ForgotPasswordFormValues) {
    setSentEmail(data.email);
    forgot.mutate(data, {
      onSuccess: () => setSubmitted(true),
    });
  }

  /* ── Success state ── */
  if (submitted) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <CheckCircle2 className="size-6 text-[#084734]" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Check your email</h1>
        <p className="mt-2 text-sm text-gray-500">
          We sent a password reset link to{" "}
          <span className="font-semibold text-gray-700">{sentEmail}</span>.
          <br />
          The link expires in 30 minutes.
        </p>

        <div className="mt-6 rounded-xl border border-gray-100 bg-white px-6 py-4 shadow-sm text-left space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Didn't get it?</p>
          <ul className="space-y-1 text-sm text-gray-500">
            <li>• Check your spam / junk folder</li>
            <li>• Make sure the email address above is correct</li>
            <li>
              •{" "}
              <button
                type="button"
                onClick={() => setSubmitted(false)}
                className="font-semibold text-[#084734] hover:text-[#3d6000] transition-colors"
              >
                Try again with a different email
              </button>
            </li>
          </ul>
        </div>

        <Link
          to="/auth/login"
          className="mt-6 inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Back to sign in
        </Link>
      </div>
    );
  }

  /* ── Default state ── */
  return (
    <div>
      {/* Heading */}
      <div className="mb-7">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#CEF17B]/30">
          <Mail className="size-5 text-[#084734]" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Forgot your password?</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          No problem. Enter your email and we'll send you a reset link.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Email */}
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
            Email address
          </label>
          <input
            id="email"
            type="email"
            placeholder="john@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition aria-[invalid=true]:border-red-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
          {errors.email && (
            <p id="email-error" className="text-xs text-red-700">{errors.email.message}</p>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-600">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={forgot.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-[#BADE6F] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {forgot.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Sending link…
            </>
          ) : (
            "Send reset link"
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
