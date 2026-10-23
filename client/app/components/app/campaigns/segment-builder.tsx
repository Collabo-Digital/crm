import { Plus, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RFM_LABEL } from "~/lib/campaign-format";
import { VIP_LABELS } from "~/lib/customer-status";
import { cn } from "~/lib/utils";
import type { RfmGroup, SegmentDefinition, SegmentRule, VipLevel } from "~/types/api";

type Field = SegmentRule["field"];

/** Each rule field: its label, the comparisons it offers and a starting rule. */
const FIELDS: Array<{ field: Field; label: string; group: string; ops: Array<[string, string]>; make: () => SegmentRule }> = [
  { field: "tag", label: "Tag", group: "Contact", ops: [["has", "has"], ["not_has", "does not have"]], make: () => ({ field: "tag", op: "has", value: "" }) },
  { field: "channel", label: "Channel", group: "Contact", ops: [["is", "is"], ["is_not", "is not"]], make: () => ({ field: "channel", op: "is", value: "" }) },
  {
    field: "attribute",
    label: "Attribute",
    group: "Contact",
    ops: [["equals", "is"], ["not_equals", "is not"], ["contains", "contains"], ["exists", "is set"], ["not_exists", "is not set"]],
    make: () => ({ field: "attribute", key: "", op: "equals", value: "" }),
  },
  { field: "consent", label: "Marketing consent", group: "Contact", ops: [["is", "is"]], make: () => ({ field: "consent", op: "is", value: "not_opted_out" }) },
  {
    field: "last_message",
    label: "Last message from them",
    group: "Contact",
    ops: [["within_days", "in the last"], ["before_days", "more than"], ["never", "never"]],
    make: () => ({ field: "last_message", op: "within_days", value: 30 }),
  },
  { field: "first_seen", label: "First seen", group: "Contact", ops: [["within_days", "in the last"], ["before_days", "more than"]], make: () => ({ field: "first_seen", op: "within_days", value: 30 }) },
  { field: "customer", label: "Store customer", group: "Store", ops: [["linked", "is linked"], ["not_linked", "is not linked"]], make: () => ({ field: "customer", op: "linked" }) },
  { field: "orders_count", label: "Orders", group: "Store", ops: [["gte", "at least"], ["lte", "at most"], ["eq", "exactly"]], make: () => ({ field: "orders_count", op: "gte", value: 1 }) },
  { field: "total_spent", label: "Total spent", group: "Store", ops: [["gte", "at least"], ["lte", "at most"]], make: () => ({ field: "total_spent", op: "gte", value: 1000 }) },
  { field: "last_order", label: "Last order", group: "Store", ops: [["within_days", "in the last"], ["before_days", "more than"]], make: () => ({ field: "last_order", op: "within_days", value: 30 }) },
  { field: "vip", label: "VIP level", group: "Store", ops: [["in", "is one of"]], make: () => ({ field: "vip", op: "in", value: [] }) },
  { field: "rfm", label: "RFM group", group: "Store", ops: [["in", "is one of"]], make: () => ({ field: "rfm", op: "in", value: [] }) },
  { field: "shopify_segment", label: "Shopify segment", group: "Store", ops: [["in", "is"], ["not_in", "is not"]], make: () => ({ field: "shopify_segment", op: "in", value: "" }) },
  {
    field: "broadcast",
    label: "Broadcast",
    group: "Engagement",
    ops: [["received", "received"], ["read", "read"], ["replied", "replied to"], ["clicked", "tapped a button in"], ["not_read", "did not read"], ["failed", "failed to receive"]],
    make: () => ({ field: "broadcast", op: "received", value: "" }),
  },
];

const selectClass = "h-8 min-w-0 max-w-full rounded-lg border bg-background px-2 text-body";
const DAYS_SUFFIX: Partial<Record<Field, string>> = { last_message: "days ago", first_seen: "days ago", last_order: "days ago" };

/** Toggle chips for a multi-choice rule value (VIP levels, RFM groups). */
function Chips<T extends string>({ options, value, onChange }: { options: Array<[T, string]>; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([key, label]) => {
        const on = value.includes(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(on ? value.filter((v) => v !== key) : [...value, key])}
            aria-pressed={on}
            className={cn(
              "rounded-full px-2.5 py-1 text-caption font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              on ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The rules of a segment: match all or any, and one row per rule. Each row
 * is field → comparison → value, and changing the field resets the rest.
 */
export function SegmentBuilder({
  definition,
  onChange,
  tags,
  channels,
  broadcasts,
  rfmCounts,
  shopifySegments = [],
}: {
  definition: SegmentDefinition;
  onChange: (definition: SegmentDefinition) => void;
  tags: string[];
  channels: Array<{ id: string; name: string }>;
  broadcasts: Array<{ id: string; name: string }>;
  rfmCounts?: Partial<Record<RfmGroup, number>>;
  /** Linked under Segments → Shopify segments. */
  shopifySegments?: Array<{ id: string; name: string }>;
}) {
  const setRule = (index: number, rule: SegmentRule) =>
    onChange({ ...definition, rules: definition.rules.map((r, i) => (i === index ? rule : r)) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-body">
        Contacts matching
        <select
          className={selectClass}
          value={definition.match}
          onChange={(e) => onChange({ ...definition, match: e.target.value as "all" | "any" })}
          aria-label="Match all or any rule"
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of these rules
      </div>

      {definition.rules.map((rule, index) => {
        const spec = FIELDS.find((f) => f.field === rule.field)!;
        const anyRule = rule as Record<string, unknown>;
        return (
          <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5">
            <select
              className={selectClass}
              value={rule.field}
              onChange={(e) => setRule(index, FIELDS.find((f) => f.field === e.target.value)!.make())}
              aria-label="Rule field"
            >
              {["Contact", "Store", "Engagement"].map((group) => (
                <optgroup key={group} label={group}>
                  {FIELDS.filter((f) => f.group === group).map((f) => (
                    <option key={f.field} value={f.field}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {rule.field === "attribute" && (
              <Input className="h-8 w-32" value={rule.key} onChange={(e) => setRule(index, { ...rule, key: e.target.value })} placeholder="Attribute" aria-label="Attribute name" />
            )}

            {spec.ops.length > 1 || rule.field === "consent" ? (
              <select
                className={selectClass}
                value={String(anyRule.op)}
                onChange={(e) => setRule(index, { ...rule, op: e.target.value } as SegmentRule)}
                aria-label="Comparison"
              >
                {spec.ops.map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-body text-muted-foreground">{spec.ops[0][1]}</span>
            )}

            {rule.field === "tag" && (
              <>
                <Input
                  className="h-8 w-40"
                  value={rule.value}
                  onChange={(e) => setRule(index, { ...rule, value: e.target.value })}
                  placeholder="Tag"
                  list="segment-tags"
                  aria-label="Tag"
                />
                <datalist id="segment-tags">
                  {tags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </>
            )}
            {rule.field === "channel" && (
              <select className={selectClass} value={rule.value} onChange={(e) => setRule(index, { ...rule, value: e.target.value })} aria-label="Channel">
                <option value="">Choose a channel</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {rule.field === "attribute" && rule.op !== "exists" && rule.op !== "not_exists" && (
              <Input className="h-8 w-40" value={rule.value ?? ""} onChange={(e) => setRule(index, { ...rule, value: e.target.value })} placeholder="Value" aria-label="Value" />
            )}
            {rule.field === "consent" && (
              <select className={selectClass} value={rule.value} onChange={(e) => setRule(index, { ...rule, value: e.target.value as typeof rule.value })} aria-label="Consent">
                <option value="not_opted_out">not opted out</option>
                <option value="opted_in">opted in</option>
                <option value="opted_out">opted out</option>
              </select>
            )}
            {(rule.field === "last_message" || rule.field === "first_seen" || rule.field === "last_order") && rule.op !== "never" && (
              <>
                <Input
                  type="number"
                  min={1}
                  className="h-8 w-20"
                  value={rule.value ?? ""}
                  onChange={(e) => setRule(index, { ...rule, value: Math.max(1, Number(e.target.value) || 1) } as SegmentRule)}
                  aria-label="Days"
                />
                <span className="text-body text-muted-foreground">{DAYS_SUFFIX[rule.field]}</span>
              </>
            )}
            {(rule.field === "orders_count" || rule.field === "total_spent") && (
              <Input
                type="number"
                min={0}
                className="h-8 w-28"
                value={rule.value}
                onChange={(e) => setRule(index, { ...rule, value: Math.max(0, Number(e.target.value) || 0) } as SegmentRule)}
                aria-label="Amount"
              />
            )}
            {rule.field === "vip" && (
              <Chips<VipLevel>
                options={(["BRONZE", "SILVER", "GOLD", "PLATINUM"] as VipLevel[]).map((v) => [v, VIP_LABELS[v]])}
                value={rule.value}
                onChange={(value) => setRule(index, { ...rule, value })}
              />
            )}
            {rule.field === "rfm" && (
              <Chips<RfmGroup>
                options={(Object.keys(RFM_LABEL) as RfmGroup[]).map((g) => [g, `${RFM_LABEL[g].label}${rfmCounts?.[g] !== undefined ? ` · ${rfmCounts[g]}` : ""}`])}
                value={rule.value}
                onChange={(value) => setRule(index, { ...rule, value })}
              />
            )}
            {rule.field === "shopify_segment" && (
              <select className={selectClass} value={rule.value} onChange={(e) => setRule(index, { ...rule, value: e.target.value })} aria-label="Shopify segment">
                <option value="">{shopifySegments.length ? "Choose a Shopify segment" : "Link one under Segments first"}</option>
                {shopifySegments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {rule.field === "broadcast" && (
              <select className={selectClass} value={rule.value} onChange={(e) => setRule(index, { ...rule, value: e.target.value })} aria-label="Broadcast">
                <option value="">Choose a broadcast</option>
                {broadcasts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              disabled={definition.rules.length === 1}
              onClick={() => onChange({ ...definition, rules: definition.rules.filter((_, i) => i !== index) })}
              aria-label="Remove rule"
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}

      <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...definition, rules: [...definition.rules, FIELDS[0].make()] })}>
        <Plus />
        Add rule
      </Button>
    </div>
  );
}

/** A rule set the server will accept: every value filled in. */
export function isComplete(definition: SegmentDefinition): boolean {
  return definition.rules.every((r) => {
    switch (r.field) {
      case "tag":
      case "channel":
      case "broadcast":
      case "shopify_segment":
        return !!r.value;
      case "attribute":
        return !!r.key && (r.op === "exists" || r.op === "not_exists" || !!r.value);
      case "vip":
      case "rfm":
        return r.value.length > 0;
      default:
        return true;
    }
  });
}
