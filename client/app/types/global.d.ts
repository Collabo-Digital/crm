/**
 * Global declarations for the Meta JavaScript SDK (Facebook Login / WhatsApp
 * Embedded Signup). Loaded on demand by lib/meta-sdk.ts.
 *
 * The SDK is typed loosely as `any` because we only touch `FB.init` and
 * `FB.login` — building full types for the whole SDK is not worth the weight.
 */
declare global {
  interface Window {
    FB?: {
      init: (options: {
        appId: string;
        cookie?: boolean;
        xfbml?: boolean;
        version: string;
      }) => void;
      login: (
        callback: (response: {
          authResponse?: {
            code?: string;
            accessToken?: string;
            userID?: string;
          } | null;
          status?: string;
        }) => void,
        options?: {
          config_id?: string;
          response_type?: string;
          override_default_response_type?: boolean;
          scope?: string;
          extras?: Record<string, unknown>;
        },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

export {};
