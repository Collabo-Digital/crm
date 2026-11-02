import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { capabilitiesFor, matchingTemplate, type JobTemplate } from "~/lib/member-access";
import { AVAILABLE_SECTIONS, type SectionId } from "~/lib/sections";
import type { UserRole } from "~/types/api";

export { accessGrants, DEFAULT_CAPABILITIES } from "~/lib/member-access";

/**
 * Checkbox grid of the app sections a member may open. Used on the invite form
 * and the per-member access editor. At least one section stays ticked — a
 * member with none would read as "not configured", which means full access —
 * unless `allowNone`: the member's job (the till) is access on its own.
 */
export function SectionAccessPicker({
  value,
  onChange,
  disabled,
  allowNone = false,
}: {
  value: SectionId[];
  onChange: (next: SectionId[]) => void;
  disabled?: boolean;
  allowNone?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {AVAILABLE_SECTIONS.map((section) => {
        const checked = value.includes(section.id);
        const isLast = checked && value.length === 1 && !allowNone;
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

/** Checkboxes for the abilities under each ticked section, then the section-less jobs. */
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
  const offered = capabilitiesFor(role, sections, value);
  const groups: Array<{ id: string; heading: string; items: typeof offered }> = [
    ...AVAILABLE_SECTIONS.map((s) => ({ id: s.id, heading: `In ${s.label}`, items: offered.filter((c) => c.section === s.id) })),
    ...[...new Set(offered.filter((c) => c.section === null).map((c) => c.heading ?? ""))].map((heading) => ({
      id: heading,
      heading,
      items: offered.filter((c) => c.section === null && (c.heading ?? "") === heading),
    })),
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.id} className="space-y-1.5">
          <p className="text-caption font-medium text-muted-foreground">{group.heading}</p>
          <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-4">
            {group.items.map((capability) => (
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
 * abilities, which stay editable. The templates are the server's
 * (PERMISSION_PRESETS); the button whose grants the editor would save
 * exactly shows as pressed, with its description.
 */
export function JobPresetPicker({
  templates,
  sections,
  capabilities,
  onPick,
  disabled,
}: {
  templates: readonly JobTemplate[];
  sections: SectionId[];
  capabilities: string[];
  onPick: (template: JobTemplate) => void;
  disabled?: boolean;
}) {
  if (templates.length === 0) return null;
  const active = matchingTemplate(templates, "AGENT", sections, capabilities);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium text-muted-foreground">Start from a job:</span>
        {templates.map((template) => (
          <Button
            key={template.id}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={active?.id === template.id}
            className="aria-pressed:border-brand-strong aria-pressed:bg-brand/30"
            disabled={disabled}
            onClick={() => onPick(template)}
          >
            {template.label}
          </Button>
        ))}
      </div>
      {active && <p className="text-caption text-muted-foreground">{active.description}</p>}
    </div>
  );
}
