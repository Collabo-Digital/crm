import { toast } from "sonner";

/** Graph API version the JS SDK is initialised with. Matches the server's. */
export const META_SDK_VERSION = "v25.0";

let loading: Promise<boolean> | null = null;

/**
 * Loads Meta's JavaScript SDK the first time a feature needs it (WhatsApp,
 * Messenger and Ads connect), so no other page runs Meta's code. Resolves once
 * `window.FB` is initialised; callers share one load. Its loader puts a stub
 * on `window.FB` before the real SDK arrives, so a load in progress is awaited
 * rather than trusting `window.FB`.
 */
export function ensureMetaSdk(): Promise<boolean> {
  if (loading) return loading;
  // Already there from before this module was loaded (a hot reload).
  if (window.FB) return Promise.resolve(true);

  const appId = import.meta.env.VITE_META_APP_ID;
  if (!appId) {
    toast.error(
      "VITE_META_APP_ID is missing from client environment. Set it in .env and restart the dev server.",
    );
    return Promise.resolve(false);
  }

  loading = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      if (error) toast.error(error);
      resolve(ready);
    };
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, cookie: true, xfbml: false, version: META_SDK_VERSION });
      finish(true);
    };
    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.onerror = () => {
        // Removed so the next try adds it again.
        script.remove();
        finish(false, "Failed to load Meta SDK. Check your network.");
      };
      document.body.appendChild(script);
    }
    // Safety timeout — if SDK never loads within 10s, bail.
    setTimeout(() => finish(false, "Meta SDK did not load in time. Please try again."), 10000);
  }).then((ready) => {
    if (!ready) loading = null;
    return ready;
  });
  return loading;
}
