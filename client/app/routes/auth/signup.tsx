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

export function meta() {
  return [
    { title: "Sign Up | Collabo CRM" },
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
        <h2 className="text-[38px] font-bold text-gray-900">Get Started</h2>
        <p className="mt-1.5 text-[14px] text-gray-500">
          Start managing your commerce operations
          from one unified platform.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Name row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="">
            <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1.5">
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
          <div className="">
            <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1.5">
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

        {/* Email */}
        <div className="">
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
            Email address
          </label>
          <input
            id="email"
            type="email"
            placeholder="john@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            {...register("email")}
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
          />
          {errors.email && (
            <p className="text-xs text-red-500">{errors.email.message}</p>
          )}
        </div>

        {/* Password */}
        <div className="">
          <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1.5">
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
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
              onClick={() => setShowPassword((visible) => !visible)}
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.password && (
            <p className="text-xs text-red-500">{errors.password.message}</p>
          )}
        </div>

        {/* Server error */}
        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-600">{serverError}</p>
          </div>
        )}

        {/* T&C note */}
        {/* <p className="text-[11px] text-gray-400">
          By creating an account you agree to our{" "}
          <a href="#" className="underline hover:text-gray-600">Terms of Service</a>
          {" "}and{" "}
          <a href="#" className="underline hover:text-gray-600">Privacy Policy</a>.
        </p> */}

        {/* Submit */}
        <button
          type="submit"
          disabled={signup.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#000000] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:opacity-60 mt-4"
        >
          {signup.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating account…
            </>
          ) : (
            "Create account"
          )}
        </button>
      </form>

      {/* Footer */}
      <p className="mt-3 text-center text-sm text-gray-500">
        Already have an account?{" "}
        <Link
          to={withNext("/auth/login", next)}
          className="font-semibold text-[#084734] hover:text-[#3d6000] transition-colors"
        >
          Sign in
        </Link>
      </p>

      <p className="mt-3 text-center text-[14px] text-gray-500 ">
        By creating an account, you agree to  <Link to="https://grow100x.app/terms-and-conditions.html" className="text-[#084734] hover:text-[#3d6000] transition-colors">Terms of service</Link> and <Link to="https://grow100x.app/privacy-policy.html" className="text-[#084734] hover:text-[#3d6000] transition-colors">Privacy policy</Link>
      </p>
    </div>
  );
}
