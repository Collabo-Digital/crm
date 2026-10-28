import { useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAxiosError } from "axios";
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";

import { useForgotPasswordMutation } from "~/hooks/use-auth-mutations";
import { Button } from "~/components/ui/button";

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
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand/30">
          <CheckCircle2 className="size-6 text-brand-strong" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a password reset link to{" "}
          <span className="font-semibold text-foreground">{sentEmail}</span>.
          <br />
          The link expires in 30 minutes.
        </p>

        <div className="mt-6 rounded-xl border border-border bg-card px-6 py-4 shadow-sm text-left space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Didn't get it?</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>• Check your spam / junk folder</li>
            <li>• Make sure the email address above is correct</li>
            <li>
              •{" "}
              <button
                type="button"
                onClick={() => setSubmitted(false)}
                className="font-semibold text-brand-strong hover:text-brand-strong-hover transition-colors"
              >
                Try again with a different email
              </button>
            </li>
          </ul>
        </div>

        <Link
          to="/auth/login"
          className="mt-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
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
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand/30">
          <Mail className="size-5 text-brand-strong" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Forgot your password?</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          No problem. Enter your email and we'll send you a reset link.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Email */}
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
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
            className="h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition aria-[invalid=true]:border-destructive focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
          {errors.email && (
            <p id="email-error" className="text-xs text-danger-text">{errors.email.message}</p>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-sm text-danger-text">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <Button type="submit" size="lg" disabled={forgot.isPending} className="h-11 w-full font-semibold">
          {forgot.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Sending link…
            </>
          ) : (
            "Send reset link"
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
