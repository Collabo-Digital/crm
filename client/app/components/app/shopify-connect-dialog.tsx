import { useEffect, useState } from "react";
import {
  Loader2, ShoppingBag, Eye, EyeOff, ExternalLink,
  ChevronDown, ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import {
  useInstallShopifyMutation,
  useManualConnectShopifyMutation,
} from "~/hooks/use-channel-mutations";

interface ShopifyConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled when the merchant arrives from the embedded Shopify app (?install_shop=). */
  initialDomain?: string;
  /** A connect that needed no redirect, so the caller can go on to its locations. */
  onConnected?: (channelId: string) => void;
}

/**
 * Dialog for connecting a Shopify store. Two self-contained paths:
 *
 * 1. PUBLIC APP (primary): store domain only — the platform's own Shopify
 *    app is installed via OAuth; client id/secret come from server env.
 *
 * 2. CUSTOM APP (collapsed "Advanced" section): the merchant's own app.
 *    Fields: store domain + Client ID + Client Secret + Access token
 *    (optional).
 *      • Access token filled  → app created in the STORE ADMIN → instant
 *        manual connect, no redirect.
 *      • Access token empty   → app created in the PARTNER DASHBOARD →
 *        the same OAuth flow runs but with the entered credentials; the
 *        token is fetched automatically.
 */
export function ShopifyConnectDialog({ open, onOpenChange, initialDomain, onConnected }: ShopifyConnectDialogProps) {
  // ── Public app section ──
  const [shopDomain, setShopDomain] = useState("");

  // ── Custom app section ──
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customDomain, setCustomDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const install = useInstallShopifyMutation();
  const manualConnect = useManualConnectShopifyMutation();

  useEffect(() => {
    if (open && initialDomain) {
      setShopDomain(initialDomain.replace(/\.myshopify\.com$/i, ""));
    }
  }, [open, initialDomain]);

  function resetCustomForm() {
    setCustomDomain("");
    setApiKey("");
    setApiSecret("");
    setAccessToken("");
  }

  function handlePublicInstall() {
    if (!shopDomain.trim()) return;
    // Server normalizes authoritatively ("my-store" / full domain / URL all work)
    install.mutate({ shopDomain: shopDomain.trim() });
  }

  function normalizeDomainForManual(input: string): string {
    let domain = input.trim()
      .replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\/admin.*$/, "");
    if (!domain.includes(".myshopify.com")) domain = `${domain}.myshopify.com`;
    return domain;
  }

  function handleCustomConnect() {
    if (!customDomain.trim() || !apiKey.trim() || !apiSecret.trim()) return;

    if (accessToken.trim()) {
      // Store-admin custom app: the token was revealed once in the admin —
      // connect instantly, no OAuth redirect.
      manualConnect.mutate(
        {
          shopDomain: normalizeDomainForManual(customDomain),
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          accessToken: accessToken.trim(),
        },
        {
          onSuccess: (response) => {
            resetCustomForm();
            onOpenChange(false);
            onConnected?.(response.channelId);
          },
        },
      );
    } else {
      // Partner-Dashboard custom app: run OAuth with the entered credentials;
      // the access token is captured automatically by the callback.
      install.mutate({
        shopDomain: customDomain.trim(),
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
      });
    }
  }

  const isCustomFormValid = customDomain.trim() && apiKey.trim() && apiSecret.trim();
  const customIsPending = install.isPending || manualConnect.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[#96bf48]/20">
              <ShoppingBag className="size-4 text-[#96bf48]" />
            </div>
            Connect Shopify Store
          </DialogTitle>
          <DialogDescription>
            Enter your store domain — you&apos;ll be redirected to Shopify to approve the connection.
          </DialogDescription>
        </DialogHeader>

        {/* ── Primary: public-app OAuth install ── */}
        <div className="space-y-3 py-1">
          <div>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              Store domain <span className="text-red-500">*</span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handlePublicInstall()}
                placeholder="my-store"
                className="flex-1 rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
              />
              <span className="shrink-0 text-xs text-muted-foreground">.myshopify.com</span>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
            <p className="text-[10px] font-medium text-gray-600 dark:text-gray-400 mb-1">What happens next:</p>
            <ol className="space-y-0.5 text-[10px] text-muted-foreground list-decimal list-inside">
              <li>You&apos;ll be redirected to Shopify to review and approve the app</li>
              <li>After approval you&apos;ll land back here, connected</li>
              <li>Products, orders, and customers start syncing automatically</li>
            </ol>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePublicInstall}
              disabled={install.isPending || !shopDomain.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#CEF17B] px-4 py-2.5 text-sm font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {install.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Redirecting to Shopify…
                </>
              ) : (
                <>
                  Install &amp; Connect
                  <ExternalLink className="size-3.5" />
                </>
              )}
            </button>
            <button
              onClick={() => onOpenChange(false)}
              className="rounded-lg px-4 py-2.5 text-sm text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* ── Advanced: connect with your own custom app ── */}
        <div className="border-t pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Advanced: connect with a custom app instead
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800 p-3">
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Use your own Shopify app&apos;s credentials.{" "}
                  <strong>App created in the Partner Dashboard?</strong> Enter the Client ID and
                  Client Secret, leave the access token empty — we&apos;ll fetch it automatically.
                  Make sure the app has been installed on the store once via its Distribution
                  install link.{" "}
                  <strong>App created in your store admin</strong> (Settings → Apps → Develop
                  apps)? Also paste the Admin API access token shown when you installed it.
                </p>
              </div>

              {/* Store domain */}
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Store domain <span className="text-red-500">*</span>
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="my-store"
                    className="flex-1 rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">.myshopify.com</span>
                </div>
              </div>

              {/* Client ID */}
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Client ID (API key) <span className="text-red-500">*</span>
                </label>
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="From the app's API credentials"
                  className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono outline-none placeholder:text-gray-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                />
              </div>

              {/* Client Secret */}
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Client Secret <span className="text-red-500">*</span>
                </label>
                <div className="relative mt-1">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder="shpss_xxxxxxxxxxxxxxxxxxxxx"
                    className="w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 pr-10 text-sm font-mono outline-none placeholder:text-gray-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>

              {/* Admin API Access Token — optional */}
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Admin API access token{" "}
                  <span className="text-muted-foreground font-normal">(only for store-admin apps)</span>
                </label>
                <div className="relative mt-1">
                  <input
                    type={showToken ? "text" : "password"}
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="shpat_xxxxxxxxxxxxxxxxxxxxx — leave empty for Partner Dashboard apps"
                    className="w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 pr-10 text-sm font-mono outline-none placeholder:text-gray-400 focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>

              <button
                onClick={handleCustomConnect}
                disabled={customIsPending || !isCustomFormValid}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-input bg-white dark:bg-gray-900 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {customIsPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {accessToken.trim() ? "Connecting…" : "Redirecting to Shopify…"}
                  </>
                ) : accessToken.trim() ? (
                  "Connect with access token"
                ) : (
                  <>
                    Connect via Shopify
                    <ExternalLink className="size-3.5" />
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
