import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import type { PermissionKey } from "~/lib/permissions";
import { AVAILABLE_SECTIONS, sectionKey, type SectionId } from "~/lib/sections";
import type { UserRole } from "~/types/api";

/**
 * Checkbox grid of the app sections a member may open. Used on the invite form
 * and the per-member access editor. At least one section stays ticked — a
 * member with none would read as "not configured", which means full access.
 */
export function SectionAccessPicker({
  value,
  onChange,
  disabled,
}: {
  value: SectionId[];
  onChange: (next: SectionId[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {AVAILABLE_SECTIONS.map((section) => {
        const checked = value.includes(section.id);
        const isLast = checked && value.length === 1;
        return (
          <label
            key={section.id}
            className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
          >
            <Checkbox
              checked={checked}
              disabled={disabled || isLast}
              onCheckedChange={(next) =>
                onChange(
                  next === true
                    ? [...value, section.id]
                    : value.filter((id) => id !== section.id),
                )
              }
            />
            {section.label}
          </label>
        );
      })}
    </div>
  );
}

interface Capability {
  key: PermissionKey;
  /** The section it sits under, or null for one offered whatever the sections (shown under "Warehouse"). */
  section: SectionId | null;
  label: string;
  /** Viewers only read: the server refuses them these actions whatever they hold. */
  agentOnly?: boolean;
}

/**
 * What an Agent / Viewer may do inside a section, beyond opening it. The
 * server decides the inbox queue and every campaign action on these grants,
 * so without them an Agent's inbox shows only chats already assigned to them.
 */
const CAPABILITIES: Capability[] = [
  { key: "chat.view_unassigned", section: "chat", label: "See new, unassigned chats" },
  { key: "chat.view_all", section: "chat", label: "See chats assigned to teammates" },
  { key: "chat.assign", section: "chat", label: "Assign chats to teammates", agentOnly: true },
  { key: "campaigns.manage", section: "campaigns", label: "Create and edit broadcasts and segments", agentOnly: true },
  { key: "broadcasts.send", section: "campaigns", label: "Send broadcasts to customers", agentOnly: true },
  { key: "templates.manage", section: "campaigns", label: "Submit message templates to Meta", agentOnly: true },
  // Not under Orders: a packer works from the Packing list and need not see every order.
  { key: "inventory.pack", section: null, label: "Pack orders, with the Packing list and scanner", agentOnly: true },
];

/** What a new Agent / Viewer starts with: they can pick up new chats. */
export const DEFAULT_CAPABILITIES: PermissionKey[] = ["chat.view_unassigned"];

/**
 * Every grant the access editor writes. Anything else on a member (the other
 * inventory.* keys, reports.finance) is left as it was when the editor saves.
 */
export const MANAGED_CAPABILITY_KEYS = new Set<string>(["campaigns.view", ...CAPABILITIES.map((c) => c.key)]);

function capabilitiesFor(role: UserRole, sections: SectionId[]) {
  return CAPABILITIES.filter((c) => (c.section === null || sections.includes(c.section)) && (role === "AGENT" || !c.agentOnly));
}

/**
 * The grant list for an Agent / Viewer: each section, `campaigns.view` with
 * Campaigns (the section stays locked without it), and the capabilities the
 * role can use in the sections it opens.
 */
export function accessGrants(role: UserRole, sections: SectionId[], capabilities: readonly string[]): string[] {
  const offered = new Set<string>(capabilitiesFor(role, sections).map((c) => c.key));
  return [
    ...sections.map(sectionKey),
    ...(sections.includes("campaigns") ? ["campaigns.view"] : []),
    ...capabilities.filter((key) => offered.has(key)),
  ];
}

/** Checkboxes for the capabilities under each ticked section. */
export function CapabilityPicker({
  role,
  sections,
  value,
  onChange,
  disabled,
}: {
  role: UserRole;
  sections: SectionId[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const offered = capabilitiesFor(role, sections);
  const groups: Array<{ id: SectionId | null; heading: string }> = [
    ...AVAILABLE_SECTIONS.filter((s) => offered.some((c) => c.section === s.id)).map((s) => ({ id: s.id, heading: `In ${s.label}` })),
    ...(offered.some((c) => c.section === null) ? [{ id: null, heading: "Warehouse" }] : []),
  ];
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.id ?? "warehouse"} className="space-y-1.5">
          <p className="text-caption font-medium text-muted-foreground">{group.heading}</p>
          <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-4">
            {offered
              .filter((c) => c.section === group.id)
              .map((capability) => (
                <label
                  key={capability.key}
                  className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
                >
                  <Checkbox
                    checked={value.includes(capability.key)}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      onChange(
                        next === true
                          ? [...value, capability.key]
                          : value.filter((key) => key !== capability.key),
                      )
                    }
                  />
                  {capability.label}
                </label>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One-click starting points for the jobs owners hire for most, so adding a
 * packer is not eight unticks and a tick. Each fills the sections and
 * abilities, which stay editable. A member always keeps one section (none
 * means full access), so a packer also opens Products, to look items up —
 * the same set as the server's `packer` preset.
 */
export const JOB_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  sections: SectionId[];
  capabilities: PermissionKey[];
}> = [
  {
    id: "packer",
    label: "Packer",
    description: "Packs orders with the Packing list and scanner, and can look products up. No orders, customers or sales figures.",
    sections: ["products"],
    capabilities: ["inventory.pack"],
  },
  {
    id: "support",
    label: "Support agent",
    description: "Answers chats in the Inbox, including new ones nobody has picked up yet. Nothing else.",
    sections: ["chat"],
    capabilities: ["chat.view_unassigned"],
  },
];

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The preset these sections and abilities match exactly, if any. */
export function matchingPreset(sections: readonly SectionId[], capabilities: readonly string[]) {
  return JOB_PRESETS.find((p) => sameSet(p.sections, sections) && sameSet(p.capabilities, capabilities));
}

/** The job buttons above the section grid, for Agents. */
export function JobPresetPicker({
  sections,
  capabilities,
  onPick,
  disabled,
}: {
  sections: SectionId[];
  capabilities: string[];
  onPick: (preset: (typeof JOB_PRESETS)[number]) => void;
  disabled?: boolean;
}) {
  const active = matchingPreset(sections, capabilities);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium text-muted-foreground">Start from a job:</span>
        {JOB_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={active?.id === preset.id}
            className="aria-pressed:border-brand-strong aria-pressed:bg-brand/30"
            disabled={disabled}
            onClick={() => onPick(preset)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      {active && <p className="text-caption text-muted-foreground">{active.description}</p>}
    </div>
  );
}
