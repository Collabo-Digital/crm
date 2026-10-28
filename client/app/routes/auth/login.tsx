import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { loginSchema } from "~/lib/schemas/auth.schemas";
import type { LoginFormValues } from "~/lib/schemas/auth.schemas";
import { useLoginMutation } from "~/hooks/use-auth-mutations";
import { withNext } from "~/lib/return-path";
import { AUTH_INPUT } from "~/lib/auth-ui";
import { PRIVACY_URL, TERMS_URL } from "~/lib/support";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function meta() {
  return [
    { title: "Sign in | Collabo CRM" },
    { name: "description", content: "Log in to your Collabo CRM account" },
  ];
}

/**
 * Login page allowing existing users to sign in with email and password.
 * Displays server-side validation errors and provides a link to sign up.
 */
export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  // The page that sent the visitor here (a signed-out link, an expired
  // session, an invitation); they are returned to it afterwards rather than
  // dropped on the dashboard.
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  const login = useLoginMutation(next);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const serverError =
    login.error && isAxiosError(login.error)
      ? login.error.response?.data?.message
      : null;

  function onSubmit(data: LoginFormValues) {
    login.mutate(data);
  }

  return (
    <div>
      {/* Heading */}
      <div className="mb-7">
        <h1 className="text-[38px] font-bold text-foreground">Welcome back</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Sign in to your Collabo account to continue.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Email */}
        <div>
          <label htmlFor="email" className="mb-2.5 block text-sm font-medium text-foreground">
            Email address
          </label>
          <Input
            id="email"
            type="email"
            placeholder="john@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
            className={AUTH_INPUT}
          />
          {errors.email && (
            <p id="email-error" className="mt-1 text-xs text-danger-text">{errors.email.message}</p>
          )}
        </div>

        {/* Password */}
        <div>
          <label htmlFor="password" className="mb-2.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
              className={`${AUTH_INPUT} pr-10`}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.password && (
            <p id="password-error" className="mt-1 text-xs text-danger-text">{errors.password.message}</p>
          )}
          <div className="flex justify-end mt-4">
            <Link
              to="/auth/forgot-password"
              className="text-xs font-medium text-brand-strong hover:text-brand-strong-hover transition-colors"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-sm text-danger-text">{serverError}</p>
          </div>
        )}

        <Button type="submit" size="lg" disabled={login.isPending} className="h-11 w-full font-semibold">
          {login.isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </form>

      {/* Footer */}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          to={withNext("/auth/signup", next)}
          className="font-semibold text-brand-strong hover:text-brand-strong-hover transition-colors"
        >
          Create one
        </Link>
      </p>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        By signing in, you agree to the{" "}
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="text-brand-strong underline underline-offset-2 hover:text-brand-strong-hover transition-colors">Terms of service</a> and{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="text-brand-strong underline underline-offset-2 hover:text-brand-strong-hover transition-colors">Privacy policy</a>.
      </p>
    </div>
  );
}
