import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
} from "react-router";

import type { Route } from "./+types/root";
import { QueryProvider } from "~/providers/query-provider";
import { TooltipProvider } from "~/components/ui/tooltip";
import { Toaster } from "~/components/ui/sonner";
import { useThemeStore } from "~/stores/theme.store";
import { useAuthStore } from "~/stores/auth.store";
import { useEffect, useRef } from "react";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <Toaster position="top-right" richColors />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Loads and initializes the Meta JS SDK for WhatsApp Embedded Signup.
 * Runs once on app mount. Idempotent — if the script tag is already present
 * (e.g., after hot reload) it reuses it.
 */
function MetaSdkInit() {
  useEffect(() => {
    const appId = import.meta.env.VITE_META_APP_ID;
    if (!appId) {
      console.warn(
        "[Meta SDK] VITE_META_APP_ID is not set — WhatsApp Embedded Signup will not work.",
      );
      return;
    }

    // Tell the SDK what to do once it finishes loading.
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        cookie: true,
        xfbml: false,
        version: "v21.0",
      });
    };

    // If it's already loaded (hot reload), re-init with the current appId.
    if (window.FB) {
      window.fbAsyncInit();
      return;
    }

    // Skip if the script tag already exists (avoid duplicates on HMR).
    if (document.getElementById("facebook-jssdk")) return;

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  }, []);

  return null;
}

/** Syncs the theme store state to the document root class on mount and theme changes. */
function ThemeInit() {
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
  }, [theme]);
  return null;
}

/**
 * Watches for auth state transitions: authenticated → unauthenticated.
 * Redirects to /auth/login when logout occurs (covers API interceptor logout,
 * manual sign-out, and token refresh failure).
 */
function LogoutRedirect() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const prevAuth = useRef(isAuthenticated);

  useEffect(() => {
    if (prevAuth.current && !isAuthenticated) {
      navigate("/auth/login", { replace: true });
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated, navigate]);

  return null;
}

export default function App() {
  return (
    <QueryProvider>
      <TooltipProvider>
        <ThemeInit />
        <LogoutRedirect />
        <MetaSdkInit />
        <Outlet />
      </TooltipProvider>
    </QueryProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
