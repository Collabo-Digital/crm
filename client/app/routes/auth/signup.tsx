import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { signupSchema } from "~/lib/schemas/auth.schemas";
import type { SignupFormValues } from "~/lib/schemas/auth.schemas";
import { useSignupMutation } from "~/hooks/use-auth-mutations";
import { withNext } from "~/lib/return-path";
import { AUTH_INPUT } from "~/lib/auth-ui";
import { PRIVACY_URL, TERMS_URL } from "~/lib/support";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function meta() {
  return [
    { title: "Create your account | Collabo CRM" },
    { name: "description", content: "Create your Collabo CRM account" },
  ];
}

/**
 * Signup page for new user registration with name, email, and password fields.
 * Validates input via Zod schema and displays server-side errors.
 */
export default function SignupPage() {
  const [showPassword, setShowPassword] = useState(false);
  // The page sign-in was asked for on the way here (the Shopify install link,
  // say), opened once the new account is verified and has a workspace.
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  const signup = useSignupMutation(next);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { firstName: "", lastName: "", email: "", password: "" },
  });

  const serverError =
    signup.error && isAxiosError(signup.error)
      ? signup.error.response?.data?.message
      : null;

  function onSubmit(data: SignupFormValues) {
    signup.mutate(data);
  }

  return (
    <div>
      {/* Heading */}
      <div className="mb-7">
        <h1 className="text-[38px] font-bold text-foreground">Get started</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Run your orders, WhatsApp chats and GST invoices from one place.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Name row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="firstName" className="mb-1.5 block text-sm font-medium text-foreground">
              First name
            </label>
            <Input
              id="firstName"
              placeholder="John"
              autoComplete="given-name"
              aria-invalid={!!errors.firstName}
              aria-describedby={errors.firstName ? "firstName-error" : undefined}
              {...register("firstName")}
              className={AUTH_INPUT}
            />
            {errors.firstName && (
              <p id="firstName-error" className="mt-1 text-xs text-danger-text">{errors.firstName.message}</p>
            )}
          </div>
          <div>
            <label htmlFor="lastName" className="mb-1.5 block text-sm font-medium text-foreground">
              Last name
            </label>
            <Input
              id="lastName"
              placeholder="Doe"
              autoComplete="family-name"
              aria-invalid={!!errors.lastName}
              aria-describedby={errors.lastName ? "lastName-error" : undefined}
              {...register("lastName")}
              className={AUTH_INPUT}
            />
            {errors.lastName && (
              <p id="lastName-error" className="mt-1 text-xs text-danger-text">{errors.lastName.message}</p>
            )}
          </div>
        </div>

        {/* Email */}
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
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
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
              className={`${AUTH_INPUT} pr-10`}
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
            <p id="password-error" className="mt-1 text-xs text-danger-text">{errors.password.message}</p>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <div role="alert" className="rounded-lg bg-danger-subtle px-4 py-3">
            <p className="text-sm text-danger-text">{serverError}</p>
          </div>
        )}

        <Button type="submit" size="lg" disabled={signup.isPending} className="mt-4 h-11 w-full font-semibold">
          {signup.isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Creating account…
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>

      {/* Footer */}
      <p className="mt-3 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          to={withNext("/auth/login", next)}
          className="font-semibold text-brand-strong hover:text-brand-strong-hover transition-colors"
        >
          Sign in
        </Link>
      </p>

      <p className="mt-3 text-center text-sm text-muted-foreground">
        By creating an account, you agree to the{" "}
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="text-brand-strong underline underline-offset-2 hover:text-brand-strong-hover transition-colors">Terms of service</a> and{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="text-brand-strong underline underline-offset-2 hover:text-brand-strong-hover transition-colors">Privacy policy</a>.
      </p>
    </div>
  );
}
