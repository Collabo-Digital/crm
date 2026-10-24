import { useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router";
import { OnboardingGuard } from "~/components/guards/onboarding-guard";
import { BrandLogo } from "~/components/app/brand-logo";
import { useAuthStore } from "~/stores/auth.store";
import { signOut } from "~/lib/sign-out";

/**
 * Shared layout for the onboarding flow (account type, create org, invite team).
 * Renders a top bar with logo, main content area, and footer.
 */
export default function OnboardingLayout() {
  // Three plan cards need more room than a form.
  const wide = useLocation().pathname.endsWith("/choose-plan");
  const navigate = useNavigate();
  const email = useAuthStore((s) => s.user?.email);
  const [signingOut, setSigningOut] = useState(false);

  // Everyone here is signed in (OnboardingGuard), and the auth pages send a
  // signed-in member without a workspace straight back here — signing out is
  // the only way to switch accounts.
  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    navigate("/auth/login");
  }

  return (
    <OnboardingGuard>
      <div className="flex min-h-svh flex-col bg-[#f1f7fa]">

        {/* Top bar */}
        <header className="flex h-[64px] shrink-0 items-center justify-between gap-4 px-6 sm:px-10">
          <Link to="/" className="flex items-center">
            <BrandLogo variant="color" className="h-6" />
          </Link>

          <div className="flex min-w-0 items-center gap-3 text-sm text-gray-500">
            {email && <span className="hidden truncate sm:inline">Signed in as {email}</span>}
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="shrink-0 font-semibold text-[#084734] transition-colors hover:text-gray-800 disabled:opacity-60"
            >
              Sign out
            </button>
          </div>
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
