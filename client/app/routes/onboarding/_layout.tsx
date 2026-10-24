import { Outlet, Link, useLocation } from "react-router";
import { OnboardingGuard } from "~/components/guards/onboarding-guard";
import { BrandLogo } from "~/components/app/brand-logo";

/**
 * Shared layout for the onboarding flow (account type, create org, invite team).
 * Renders a top bar with logo, main content area, and footer.
 */
export default function OnboardingLayout() {
  // Three plan cards need more room than a form.
  const wide = useLocation().pathname.endsWith("/choose-plan");
  return (
    <OnboardingGuard>
      <div className="flex min-h-svh flex-col bg-[#f1f7fa]">

        {/* Top bar */}
        <header className="flex h-[64px] shrink-0 items-center justify-between px-6 sm:px-10">
          <Link to="/" className="flex items-center">
            <BrandLogo variant="color" className="h-6" />
          </Link>

          <Link
            to="/auth/login"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Already have an account?{" "}
            <span className="font-semibold text-[#084734]">Sign in</span>
          </Link>
        </header>

        {/* Content */}
        <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
          <div className={wide ? "w-full max-w-5xl" : "w-full max-w-2xl"}>
            <Outlet />
          </div>
        </main>

        {/* Footer */}
        <footer className="py-5 text-center text-xs text-gray-400">
          &copy; {new Date().getFullYear()} Collabo Digital Network. All rights reserved.
        </footer>
      </div>
    </OnboardingGuard>
  );
}
