import type { PermissionKey } from "./permissions.ts";
import { AVAILABLE_SECTIONS, sectionKey, sectionsInGrants, type SectionId } from "./sections.ts";
import type { UserRole } from "~/types/api";

/**
 * What the access editor (Settings › Team members, and the invite form) shows
 * and writes for an Agent / Viewer: the sections they open, and the abilities
 * inside them. Kept free of React so it can be tested on its own; the job
 * templates come from the server (GET /organizations/:orgId/members/job-templates).
 */

export interface Capability {
  key: PermissionKey;
  /** The section it sits under, or null for a job's own screen, opened without a section. */
  section: SectionId | null;
  /** The heading of a section-less ability. Sectioned ones sit under "In <section>". */
  heading?: string;
  label: string;
  /** Viewers only read: the server refuses them these actions whatever they hold. */
  agentOnly?: boolean;
  /** Offered only alongside this one, whose page it works on. */
  needs?: PermissionKey;
}

/**
 * What an Agent / Viewer may do inside a section, beyond opening it. The
 * server decides the inbox queue, every campaign action and every stock
 * action on these grants, so without them an Agent's inbox shows only chats
 * already assigned to them.
 */
export const CAPABILITIES: Capability[] = [
  { key: "chat.view_unassigned", section: "chat", label: "See new, unassigned chats" },
  { key: "chat.view_all", section: "chat", label: "See chats assigned to teammates" },
  { key: "chat.assign", section: "chat", label: "Assign chats to teammates", agentOnly: true },
  { key: "campaigns.manage", section: "campaigns", label: "Create and edit broadcasts and segments", agentOnly: true },
  { key: "broadcasts.send", section: "campaigns", label: "Send broadcasts to customers", agentOnly: true },
  { key: "templates.manage", section: "campaigns", label: "Submit message templates to Meta", agentOnly: true },
  // Agents only: a viewer's stock page could not load its locations.
  { key: "inventory.view", section: "products", label: "See stock at each location", agentOnly: true },
  { key: "inventory.receive", section: "products", label: "Receive stock", agentOnly: true, needs: "inventory.view" },
  { key: "inventory.adjust", section: "products", label: "Adjust stock counts", agentOnly: true, needs: "inventory.view" },
  { key: "inventory.labels", section: "products", label: "Print labels and product codes", agentOnly: true, needs: "inventory.view" },
  // Not under Orders: a packer works from the Packing list and need not see every order.
  { key: "inventory.pack", section: null, heading: "Warehouse", label: "Pack orders, with the Packing list and scanner", agentOnly: true },
  // Nor a cashier, who sells at the till without the order book.
  { key: "pos.sell", section: null, heading: "Point of sale", label: "Sell at the till", agentOnly: true },
];

/** What a new Agent / Viewer starts with: they can pick up new chats. */
export const DEFAULT_CAPABILITIES: PermissionKey[] = ["chat.view_unassigned"];

/**
 * Keys a ticked section brings with it, because its pages are locked without
 * them: the campaign API refuses an Agent without `campaigns.view`, and the
 * invoice API one without `reports.finance`.
 */
const SECTION_COMPANIONS: Partial<Record<SectionId, PermissionKey>> = {
  campaigns: "campaigns.view",
  invoices: "reports.finance",
};
const COMPANION_KEYS = new Set<string>(Object.values(SECTION_COMPANIONS));
const CHECKBOX_KEYS = new Set<string>(CAPABILITIES.map((c) => c.key));
const SECTION_PREFIX = "section.";

/** The abilities offered for these sections, given the ones already ticked. */
export function capabilitiesFor(role: UserRole, sections: readonly SectionId[], held: readonly string[]): Capability[] {
  return CAPABILITIES.filter(
    (c) =>
      (c.section === null || sections.includes(c.section)) &&
      (role === "AGENT" || !c.agentOnly) &&
      (!c.needs || held.includes(c.needs)),
  );
}

/**
 * The grant list for an Agent / Viewer: each section, the keys those sections
 * bring with them, and the ticked abilities the role can use in them. A key
 * with no checkbox (`inventory.pick`, say, from a job template) passes through
 * as it is, so saving never drops what the editor does not show.
 */
export function accessGrants(role: UserRole, sections: readonly SectionId[], capabilities: readonly string[]): string[] {
  const offered = new Set<string>(capabilitiesFor(role, sections, capabilities).map((c) => c.key));
  const companions = sections.flatMap((id) => SECTION_COMPANIONS[id] ?? []);
  const abilities = capabilities.filter(
    (key) => !key.startsWith(SECTION_PREFIX) && !COMPANION_KEYS.has(key) && (!CHECKBOX_KEYS.has(key) || offered.has(key)),
  );
  return [...new Set([...sections.map(sectionKey), ...companions, ...abilities])];
}

/**
 * The editor's starting point for a grant list (a member's, or a job
 * template's): the sections this build shows, and every other grant. No
 * section at all is full access, so it opens with every section ticked.
 */
export function editorAccess(grants: readonly string[]): { sections: SectionId[]; capabilities: string[] } {
  const configured = sectionsInGrants(grants);
  const shown = AVAILABLE_SECTIONS.map((s) => s.id);
  return {
    sections: configured.length === 0 ? shown : configured.filter((id) => shown.includes(id)),
    capabilities: grants.filter((g) => !g.startsWith(SECTION_PREFIX)),
  };
}

/** A job template, as GET /organizations/:orgId/members/job-templates sends it. */
export interface JobTemplate {
  id: string;
  label: string;
  description: string;
  grants: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The template these sections and abilities save as, exactly, if any. */
export function matchingTemplate<T extends JobTemplate>(
  templates: readonly T[],
  role: UserRole,
  sections: readonly SectionId[],
  capabilities: readonly string[],
): T | undefined {
  const grants = accessGrants(role, sections, capabilities);
  return templates.find((t) => sameSet(t.grants, grants));
}
