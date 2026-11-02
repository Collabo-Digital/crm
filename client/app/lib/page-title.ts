/** The name every page title ends with. */
export const APP_NAME = "Collabo CRM";

/**
 * A browser-tab title, most specific part first: ("Order #4706") gives
 * "Order #4706 | Collabo CRM" and ("Tax & GST", "Settings") gives
 * "Tax & GST · Settings | Collabo CRM". Empty parts are skipped, so a record
 * that has not loaded yet falls back to the section's title.
 */
export function pageTitle(...parts: Array<string | null | undefined>): string {
  const named = parts.map((part) => part?.trim()).filter(Boolean);
  return named.length > 0 ? `${named.join(" · ")} | ${APP_NAME}` : APP_NAME;
}

/** What a screen reader hears when a page opens: its title without the app name. */
export function spokenTitle(title: string): string {
  const suffix = ` | ${APP_NAME}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}
