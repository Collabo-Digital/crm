import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Loader2, Plus, Route, ShieldBan, Trash2 } from "lucide-react";

import { SaveBar } from "~/components/app/save-bar";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useSaveInboxRulesMutation } from "~/hooks/use-automation-mutations";
import { useInboxRules } from "~/hooks/use-automation-queries";
import { useChannels } from "~/hooks/use-channel-queries";
import type { AutomationPlatform, InboxAutoReply, InboxRoutingRule, InboxRulesSettings } from "~/types/api";
import { platformOffered } from "~/lib/channel-providers";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PLATFORMS: Array<[AutomationPlatform, string]> = ([
  ["WHATSAPP", "WhatsApp"],
  ["INSTAGRAM", "Instagram"],
  ["FACEBOOK", "Messenger"],
] as Array<[AutomationPlatform, string]>).filter(([p]) => platformOffered(p));
const selectClass = "h-8 rounded-lg border bg-background px-2 text-body disabled:opacity-60";

const CONDITION_FIELDS: Array<{ field: InboxRoutingRule["conditions"][number]["field"]; label: string; op: InboxRoutingRule["conditions"][number]["op"] }> = [
  { field: "message", label: "First message has the words", op: "contains" },
  { field: "platform", label: "Channel type is", op: "is" },
  { field: "channel", label: "Account is", op: "is" },
  { field: "tag", label: "Contact has the tag", op: "has" },
  { field: "customer", label: "Is a store customer", op: "linked" },
];

function Toggle({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
        <span className="text-body font-medium">{label}</span>
        {hint && <span className="text-micro text-muted-foreground">{hint}</span>}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function AutoReplyFields({ id, value, onChange, readOnly }: { id: string; value: InboxAutoReply; onChange: (v: InboxAutoReply) => void; readOnly: boolean }) {
  if (!value.enabled) return null;
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <Textarea id={`${id}-msg`} rows={3} value={value.message} maxLength={1000} disabled={readOnly} onChange={(e) => onChange({ ...value, message: e.target.value })} aria-label="Message" />
      <p className="text-micro text-muted-foreground">{"{{first_name}}"} is filled in, or left out when we don’t know it.</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {PLATFORMS.map(([p, label]) => (
          <label key={p} className="flex items-center gap-1.5 text-caption">
            <Checkbox
              checked={value.platforms.includes(p)}
              disabled={readOnly}
              onCheckedChange={(v) => onChange({ ...value, platforms: v === true ? [...value.platforms, p] : value.platforms.filter((x) => x !== p) })}
            />
            {label}
          </label>
        ))}
        <label className="flex items-center gap-1.5 text-caption">
          At most once per person every
          <Input type="number" min={1} max={720} className="h-7 w-16" value={value.cooldownHours} disabled={readOnly} onChange={(e) => onChange({ ...value, cooldownHours: Math.max(1, Number(e.target.value) || 1) })} />
          hours
        </label>
      </div>
    </div>
  );
}

/**
 * The inbox's own rules: when the business is open, what new and
 * out-of-hours chats hear back, who gets which conversation, and spam.
 * Automations that answer a message keep the welcome and away messages quiet.
 */
export function InboxRulesSection({ canManage, members, teams }: { canManage: boolean; members: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }> }) {
  const { data, isLoading } = useInboxRules();
  const { data: channels = [] } = useChannels();
  const save = useSaveInboxRulesMutation();
  const [s, setS] = useState<InboxRulesSettings | null>(null);
  useEffect(() => {
    if (data) {
      const { organizationTimeZone: _tz, ...rest } = data;
      setS(rest);
    }
  }, [data]);
  const readOnly = !canManage;
  const messaging = channels.filter((c) => ["WHATSAPP", "INSTAGRAM", "FACEBOOK"].includes(c.platform));

  if (isLoading || !s || !data) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const dirty = JSON.stringify(s) !== JSON.stringify((({ organizationTimeZone: _tz, ...rest }) => rest)(data));
  const setRule = (i: number, rule: InboxRoutingRule) => setS({ ...s, routing: { rules: s.routing.rules.map((r, j) => (j === i ? rule : r)) } });
  const moveRule = (i: number, by: -1 | 1) => {
    const rules = [...s.routing.rules];
    [rules[i], rules[i + by]] = [rules[i + by], rules[i]];
    setS({ ...s, routing: { rules } });
  };

  return (
    <div className="space-y-6">
      <SectionCard title="Business hours and auto-replies" icon={<Clock className="size-4 text-muted-foreground" />} description={`Times are in ${s.businessHours.timezone || data.organizationTimeZone}.`}>
        <div className="space-y-5 p-5">
          <Toggle id="bh" label="Use business hours" hint="Outside them, the away message goes out instead of the welcome." checked={s.businessHours.enabled} disabled={readOnly} onChange={(enabled) => setS({ ...s, businessHours: { ...s.businessHours, enabled } })} />
          {s.businessHours.enabled && (
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
              {DAYS.map((label, day) => {
                const entry = s.businessHours.days.find((d) => d.day === day);
                const setDay = (next: { open: string; close: string } | null) =>
                  setS({
                    ...s,
                    businessHours: {
                      ...s.businessHours,
                      days: [...s.businessHours.days.filter((d) => d.day !== day), ...(next ? [{ day, ...next }] : [])].sort((a, b) => a.day - b.day),
                    },
                  });
                return (
                  <div key={day} className="flex flex-wrap items-center gap-2 text-caption">
                    <label className="flex w-32 items-center gap-2">
                      <Checkbox checked={!!entry} disabled={readOnly} onCheckedChange={(v) => setDay(v === true ? { open: "09:00", close: "18:00" } : null)} />
                      {label}
                    </label>
                    {entry ? (
                      // Kept on one line: "to" never ends a row on its own.
                      <span className="flex items-center gap-2">
                        <Input type="time" className="h-7 w-28" value={entry.open} disabled={readOnly} onChange={(e) => setDay({ open: e.target.value, close: entry.close })} aria-label={`${label} opens`} />
                        to
                        <Input type="time" className="h-7 w-28" value={entry.close} disabled={readOnly} onChange={(e) => setDay({ open: entry.open, close: e.target.value })} aria-label={`${label} closes`} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Closed</span>
                    )}
                  </div>
                );
              })}
              <div className="flex items-center gap-2 pt-2 text-caption">
                <Label htmlFor="bh-tz" className="font-normal">Time zone</Label>
                <Input id="bh-tz" className="h-7 w-48" placeholder={data.organizationTimeZone} value={s.businessHours.timezone} disabled={readOnly} onChange={(e) => setS({ ...s, businessHours: { ...s.businessHours, timezone: e.target.value.trim() } })} />
              </div>
            </div>
          )}
          <Toggle id="welcome" label="Welcome message" hint="When a new conversation starts, or a closed one reopens, during business hours." checked={s.welcome.enabled} disabled={readOnly} onChange={(enabled) => setS({ ...s, welcome: { ...s.welcome, enabled } })} />
          <AutoReplyFields id="welcome" value={s.welcome} onChange={(welcome) => setS({ ...s, welcome })} readOnly={readOnly} />
          <Toggle id="away" label="Away message" hint="When someone writes outside business hours." checked={s.away.enabled} disabled={readOnly || !s.businessHours.enabled} onChange={(enabled) => setS({ ...s, away: { ...s.away, enabled } })} />
          {s.businessHours.enabled && <AutoReplyFields id="away" value={s.away} onChange={(away) => setS({ ...s, away })} readOnly={readOnly} />}
        </div>
      </SectionCard>

      <SectionCard title="Routing" icon={<Route className="size-4 text-muted-foreground" />} description="Who gets a new conversation. The first rule that matches wins; then round-robin, if on.">
        <div className="space-y-3 p-5">
          {s.routing.rules.map((rule, i) => (
            <div key={rule.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-1.5">
                <Input value={rule.name} maxLength={80} disabled={readOnly} onChange={(e) => setRule(i, { ...rule, name: e.target.value })} aria-label="Rule name" className="h-8 font-medium" />
                {!readOnly && (
                  <>
                    <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => moveRule(i, -1)} aria-label="Move up">
                      <ChevronUp />
                    </Button>
                    <Button variant="ghost" size="icon-sm" disabled={i === s.routing.rules.length - 1} onClick={() => moveRule(i, 1)} aria-label="Move down">
                      <ChevronDown />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setS({ ...s, routing: { rules: s.routing.rules.filter((_, j) => j !== i) } })} aria-label={`Delete ${rule.name}`}>
                      <Trash2 />
                    </Button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 text-caption">
                When
                <select className={selectClass} value={rule.match} disabled={readOnly} aria-label="Conditions that must be true" onChange={(e) => setRule(i, { ...rule, match: e.target.value as "all" | "any" })}>
                  <option value="all">all</option>
                  <option value="any">any</option>
                </select>
                of these are true
              </div>
              {rule.conditions.map((c, ci) => {
                const setCond = (next: InboxRoutingRule["conditions"][number]) => setRule(i, { ...rule, conditions: rule.conditions.map((x, j) => (j === ci ? next : x)) });
                return (
                  <div key={ci} className="flex flex-wrap items-center gap-1.5">
                    <select
                      className={selectClass}
                      value={c.field}
                      disabled={readOnly}
                      aria-label="Condition"
                      onChange={(e) => {
                        const f = CONDITION_FIELDS.find((x) => x.field === e.target.value)!;
                        setCond({ field: f.field, op: f.op, value: f.field === "platform" ? "WHATSAPP" : f.field === "channel" ? (messaging[0]?.id ?? "") : "" });
                      }}
                    >
                      {CONDITION_FIELDS.map((f) => (
                        <option key={f.field} value={f.field}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    {c.field === "platform" ? (
                      <select className={selectClass} value={c.value} disabled={readOnly} onChange={(e) => setCond({ ...c, value: e.target.value })} aria-label="Channel type">
                        {PLATFORMS.map(([p, label]) => (
                          <option key={p} value={p}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : c.field === "channel" ? (
                      <select className={selectClass} value={c.value} disabled={readOnly} onChange={(e) => setCond({ ...c, value: e.target.value })} aria-label="Account">
                        {messaging.map((ch) => (
                          <option key={ch.id} value={ch.id}>
                            {ch.name} ({ch.platform.toLowerCase()})
                          </option>
                        ))}
                      </select>
                    ) : c.field === "customer" ? (
                      <select className={selectClass} value={c.op} disabled={readOnly} onChange={(e) => setCond({ ...c, op: e.target.value as "linked" | "vip", value: e.target.value === "vip" ? "VIP" : "" })} aria-label="Customer">
                        <option value="linked">any customer</option>
                        <option value="vip">tagged VIP in the store</option>
                      </select>
                    ) : (
                      <Input className="h-8 w-48" value={c.value} maxLength={200} disabled={readOnly} placeholder={c.field === "message" ? "refund, return" : "vip"} onChange={(e) => setCond({ ...c, value: e.target.value })} aria-label="Value" />
                    )}
                    {!readOnly && rule.conditions.length > 1 && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setRule(i, { ...rule, conditions: rule.conditions.filter((_, j) => j !== ci) })} aria-label="Remove condition">
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                );
              })}
              {!readOnly && rule.conditions.length < 10 && (
                <Button variant="ghost" size="xs" onClick={() => setRule(i, { ...rule, conditions: [...rule.conditions, { field: "tag", op: "has", value: "" }] })}>
                  <Plus />
                  Condition
                </Button>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-caption">
                Assign to
                <select className={selectClass} value={rule.assign.mode} disabled={readOnly} aria-label="Assign to" onChange={(e) => setRule(i, { ...rule, assign: { ...rule.assign, mode: e.target.value as InboxRoutingRule["assign"]["mode"] } })}>
                  <option value="user">a team member</option>
                  <option value="team">a team’s queue</option>
                  <option value="round_robin">the next available agent of</option>
                </select>
                {rule.assign.mode === "user" ? (
                  <select className={selectClass} value={rule.assign.userId} disabled={readOnly} onChange={(e) => setRule(i, { ...rule, assign: { ...rule.assign, userId: e.target.value } })} aria-label="Team member">
                    <option value="">Choose</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select className={selectClass} value={rule.assign.teamId} disabled={readOnly} onChange={(e) => setRule(i, { ...rule, assign: { ...rule.assign, teamId: e.target.value } })} aria-label="Team">
                    <option value="">{rule.assign.mode === "team" ? "Choose" : "everyone"}</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ))}
          {!readOnly && s.routing.rules.length < 30 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setS({
                  ...s,
                  routing: {
                    rules: [
                      ...s.routing.rules,
                      { id: `r_${Date.now().toString(36)}`, name: `Rule ${s.routing.rules.length + 1}`, match: "all", conditions: [{ field: "message", op: "contains", value: "" }], assign: { mode: "round_robin", userId: "", teamId: "" } },
                    ],
                  },
                })
              }
            >
              <Plus />
              Add rule
            </Button>
          )}
          <div className="space-y-3 border-t pt-4">
            <Toggle id="rr" label="Round-robin" hint="Share out new conversations no rule took among online members, in turn." checked={s.roundRobin.enabled} disabled={readOnly} onChange={(enabled) => setS({ ...s, roundRobin: { ...s.roundRobin, enabled } })} />
            {s.roundRobin.enabled && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-3 text-caption">
                Among
                <select className={selectClass} value={s.roundRobin.teamId} disabled={readOnly} aria-label="Share out among" onChange={(e) => setS({ ...s, roundRobin: { ...s.roundRobin, teamId: e.target.value } })}>
                  <option value="">everyone who can reply</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                skipping anyone with
                <Input type="number" min={1} max={500} className="h-7 w-16" aria-label="Skip anyone with this many open conversations" value={s.roundRobin.maxOpenPerAgent} disabled={readOnly} onChange={(e) => setS({ ...s, roundRobin: { ...s.roundRobin, maxOpenPerAgent: Math.max(1, Number(e.target.value) || 1) } })} />
                open conversations
              </div>
            )}
            <Toggle id="ac" label="Close quiet conversations" hint="Open conversations with no messages for a while are closed. A new message reopens them." checked={s.autoClose.enabled} disabled={readOnly} onChange={(enabled) => setS({ ...s, autoClose: { ...s.autoClose, enabled } })} />
            {s.autoClose.enabled && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-3 text-caption">
                After
                <Input type="number" min={1} max={2160} className="h-7 w-20" aria-label="Hours without a message before closing" value={s.autoClose.afterHours} disabled={readOnly} onChange={(e) => setS({ ...s, autoClose: { ...s.autoClose, afterHours: Math.max(1, Number(e.target.value) || 1) } })} />
                hours without a message
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Spam" icon={<ShieldBan className="size-4 text-muted-foreground" />}>
        <div className="space-y-3 p-5">
          <Toggle id="spam" label="Tagging a contact as spam blocks them" hint="Their conversation closes and new messages from them stay closed." checked={s.spam.enabled} disabled={readOnly} onChange={(enabled) => setS({ ...s, spam: { ...s.spam, enabled } })} />
          {s.spam.enabled && (
            <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-caption">
                <Label htmlFor="spam-tag" className="font-normal">Tag</Label>
                <Input id="spam-tag" className="h-7 w-40" value={s.spam.tag} maxLength={60} disabled={readOnly} onChange={(e) => setS({ ...s, spam: { ...s.spam, tag: e.target.value } })} />
              </div>
              <label className="flex items-start gap-2 text-caption">
                <Checkbox checked={s.spam.blockOnWhatsApp} disabled={readOnly} onCheckedChange={(v) => setS({ ...s, spam: { ...s.spam, blockOnWhatsApp: v === true } })} />
                <span>
                  Also block the number on WhatsApp
                  <span className="block text-micro text-muted-foreground">WhatsApp allows this only within 24 hours of their last message. If it refuses, a note says so.</span>
                </span>
              </label>
            </div>
          )}
        </div>
      </SectionCard>

      {canManage && (
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate(s)}
          onDiscard={() => setS((({ organizationTimeZone: _tz, ...rest }) => rest)(data))}
          what="the inbox rules"
        />
      )}
    </div>
  );
}
