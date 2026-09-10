import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { loginSchema } from "~/lib/schemas/auth.schemas";
import type { LoginFormValues } from "~/lib/schemas/auth.schemas";
import { useLoginMutation } from "~/hooks/use-auth-mutations";

export function meta() {
  return [
    { title: "Log In | Collabo CRM" },
    { name: "description", content: "Log in to your Collabo CRM account" },
  ];
}

/**
 * Login page allowing existing users to sign in with email and password.
 * Displays server-side validation errors and provides a link to sign up.
 */
export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  // Set when an invitation sent the visitor here to prove who they are; they
  // are returned to it afterwards rather than dropped on the dashboard.
  const [searchParams] = useSearchParams();
  const login = useLoginMutation(searchParams.get("next"));

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

        <span className="font-display text-page-title text-brand-forest">collabo</span>
        <p className="text-[38px] font-bold text-gray-900">Welcome back</p>
        <p className="mt-1.5 text-[14px] text-sm text-gray-500">
          Sign in to your Collabo account to continue.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Email */}
        <div className="">
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2.5">
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
          <div className="flex items-center justify-between mb-2.5">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>

          </div>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...register("password")}
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 pr-10 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm outline-none transition focus:border-[#CEF17B] focus:ring-2 focus:ring-[#CEF17B]/40 aria-[invalid=true]:border-red-400"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
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
          <div className="flex justify-end mt-4">
            <Link
              to="/auth/forgot-password"
              className="text-xs font-medium text-[#084734] hover:text-[#3d6000] transition-colors"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        {/* Server error */}
        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-600">{serverError}</p>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={login.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#000000] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {login.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </form>

      {/* Footer */}
      <p className="mt-6 text-center text-sm text-gray-500">
        Don&apos;t have an account?{" "}
        <Link
          to="/auth/signup"
          className="font-semibold text-[#084734] hover:text-[#3d6000] transition-colors"
        >
          Create one
        </Link>
      </p>
      <p className="mt-6 text-center text-[14px] text-gray-500 ">
        By logging , you agree to  <Link to="https://grow100x.app/terms-and-conditions.html" className="text-[#084734] hover:text-[#3d6000] transition-colors">Terms of service</Link> and <Link to="https://grow100x.app/privacy-policy.html" className="text-[#084734] hover:text-[#3d6000] transition-colors">Privacy policy</Link>
      </p>
    </div>
  );
}
