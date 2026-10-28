import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { isAxiosError } from "axios";
import { Loader2, Mail, ArrowLeft } from "lucide-react";

import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "~/components/ui/input-otp";
import {
  useVerifyEmailMutation,
  useResendVerificationMutation,
} from "~/hooks/use-auth-mutations";
import { withNext } from "~/lib/return-path";
import { Button } from "~/components/ui/button";

export function meta() {
  return [
    { title: "Verify Email | Collabo CRM" },
    { name: "description", content: "Verify your email address" },
  ];
}

const RESEND_COOLDOWN = 60;

/** Number of OTP digits expected for email verification. */
const OTP_LENGTH = 6;

/**
 * Email verification page where users enter a 6-digit OTP code.
 * Supports auto-submit on full code entry and resend with cooldown.
 */
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const userId = searchParams.get("userId");
  // Where sign-in was headed before signup; opened once verified.
  const next = searchParams.get("next");

  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);

  const verify = useVerifyEmailMutation(next);
  const resend = useResendVerificationMutation();

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // Auto-submit when all 6 digits entered
  function handleCodeChange(value: string) {
    setCode(value);

    if (value.length === OTP_LENGTH && userId) {
      verify.mutate({ userId, code: value });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || code.length !== OTP_LENGTH) return;
    verify.mutate({ userId, code });
  }

  function handleResend() {
    if (!userId || cooldown > 0) return;
    // Reset the code and any previous error
    setCode("");
    verify.reset();
    resend.mutate({ userId });
    setCooldown(RESEND_COOLDOWN);
  }

  const serverError =
    verify.error && isAxiosError(verify.error)
      ? verify.error.response?.data?.message
      : verify.error
        ? "Something went wrong. Please try again."
        : null;

  return (
    <div>
      {/* Icon + heading */}
      <div className="mb-7 text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand/30">
          <Mail className="size-6 text-brand-strong" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Check your inbox</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a 6-digit verification code to your email address. Enter it
          below to confirm your account.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* OTP input */}
        <div className="flex justify-center">
          <InputOTP
            maxLength={OTP_LENGTH}
            value={code}
            onChange={handleCodeChange}
            disabled={verify.isPending}
          >
            <InputOTPGroup className="gap-2">
              {[0, 1, 2, 3, 4, 5].map((slotIndex) => (
                <InputOTPSlot
                  key={slotIndex}
                  index={slotIndex}
                  className="!size-11 !rounded-lg !border !border-input bg-card text-base font-bold shadow-sm transition-all data-[active=true]:!border-ring data-[active=true]:!ring-2 data-[active=true]:!ring-ring/30"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>

        {/* Server error */}
        {serverError && (
          <div className="rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-center text-sm text-danger-text">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <Button type="submit" size="lg" disabled={verify.isPending || code.length !== OTP_LENGTH} className="h-11 w-full font-semibold">
          {verify.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Verifying…
            </>
          ) : (
            "Verify email"
          )}
        </Button>
      </form>

      {/* Resend */}
      <div className="mt-5 text-center">
        <p className="text-sm text-muted-foreground">Didn&apos;t receive the code?</p>
        <button
          type="button"
          onClick={handleResend}
          disabled={cooldown > 0 || resend.isPending}
          className="mt-1 text-sm font-semibold text-brand-strong hover:text-brand-strong-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resend.isPending
            ? "Sending…"
            : cooldown > 0
              ? `Resend code (${cooldown}s)`
              : "Resend code"}
        </button>
      </div>

      {/* Back link */}
      <div className="mt-6 flex justify-center">
        <Link
          to={withNext("/auth/signup", next)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Back to sign up
        </Link>
      </div>
    </div>
  );
}
