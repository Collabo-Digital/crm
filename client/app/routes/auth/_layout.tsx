import { Outlet } from "react-router";
import { GuestGuard } from "~/components/guards/guest-guard";
import { BrandCarousel } from "~/components/app/auth/brand-carousel";
import { BrandLogo } from "~/components/app/brand-logo";

/**
 * Shared layout for all authentication pages (login, signup, verify, etc.).
 * Renders a split-screen with a brand panel on the left and a form area on the right.
 */
export default function AuthLayout() {
  return (
    <GuestGuard>
      <div className="auth-shell flex min-h-svh bg-surface-sunken p-5 lg:p-6">

        {/* ── Left brand panel ─────────────────────────────────── */}
        <div className="hidden lg:flex lg:w-[50%] flex-col justify-between rounded-4xl bg-[linear-gradient(215deg,_#000000_46%,_#94E802_100%)] p-12 relative overflow-hidden">
          <BrandCarousel className="h-full w-full" />

        </div>

        {/* ── Right form panel ─────────────────────────────────── */}
        <div className="flex flex-1 flex-col items-center justify-center px-0 py-8 sm:px-6 sm:py-6">
          <div className="w-full max-w-[400px]">
            <BrandLogo variant="color" className="mb-8 h-8" />
            <Outlet />
          </div>

          <p className="mt-8 text-center text-xs text-gray-400">
            &copy; {new Date().getFullYear()} Collabo Digital Network
          </p>
        </div>
      </div>
    </GuestGuard>
  );
}
