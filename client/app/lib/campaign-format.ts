/**
 * Display vocabulary for Campaigns: status, category and quality wording and
 * tones, and the template renderer the editor previews with. Pure.
 */
import type {
  BroadcastRecipientStatus,
  BroadcastStatus,
  BroadcastVariables,
  MessageTemplate,
  RfmGroup,
  TemplateCategory,
  TemplateDraft,
  TemplateRender,
  VariableSourceKind,
} from "~/types/api";
import { STATUS_TONE_CLASSES, toneClasses } from "./status-tone.ts";

export const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  PENDING: "In review",
  REJECTED: "Rejected",
  PAUSED: "Paused",
  DISABLED: "Disabled",
  FLAGGED: "Flagged",
  IN_APPEAL: "In appeal",
  LIMIT_EXCEEDED: "Limit exceeded",
  ARCHIVED: "Archived",
  DELETED: "Deleted",
  PENDING_DELETION: "Being deleted",
  REINSTATED: "Reinstated",
  LOCKED: "Locked",
};

export function templateStatusClass(status: string): string {
  switch (status) {
    case "APPROVED":
    case "REINSTATED":
      return STATUS_TONE_CLASSES.success;
    case "PENDING":
    case "IN_APPEAL":
      return STATUS_TONE_CLASSES.info;
    case "PAUSED":
    case "FLAGGED":
    case "LIMIT_EXCEEDED":
      return STATUS_TONE_CLASSES.attention;
    case "REJECTED":
    case "DISABLED":
    case "LOCKED":
      return STATUS_TONE_CLASSES.critical;
    default:
      return STATUS_TONE_CLASSES.neutral;
  }
}

/** Meta's rejection reasons, with what to change. */
const REJECTION_HELP: Record<string, string> = {
  INVALID_FORMAT: "Formatting problem: check variables, length and buttons",
  TAG_CONTENT_MISMATCH: "Category does not match the content",
  INCORRECT_CATEGORY: "Category does not match the content",
  PROMOTIONAL: "Promotional content needs the Marketing category",
  ABUSIVE_CONTENT: "Meta judged the content against its policies",
  SCAM: "Meta judged the content against its policies",
};

export function rejectionHelp(reason: string): string {
  return REJECTION_HELP[reason] ?? reason.toLowerCase().replace(/_/g, " ");
}

export const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
};

export const QUALITY_DOT: Record<string, string> = {
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  RED: "bg-danger",
  UNKNOWN: "bg-muted-foreground/40",
};

export const QUALITY_LABEL: Record<string, string> = {
  GREEN: "High quality",
  YELLOW: "Medium quality",
  RED: "Low quality",
  UNKNOWN: "Quality not rated yet",
};

export const BROADCAST_STATUS_LABEL: Record<BroadcastStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  SENDING: "Sending",
  COMPLETED: "Sent",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

export const BROADCAST_STATUS_CLASS = toneClasses<BroadcastStatus>({
  DRAFT: "neutral",
  SCHEDULED: "info",
  SENDING: "info",
  COMPLETED: "success",
  CANCELLED: "neutral",
  FAILED: "critical",
});

export const RECIPIENT_STATUS_LABEL: Record<BroadcastRecipientStatus, string> = {
  PENDING: "Waiting",
  SKIPPED: "Left out",
  QUEUED: "Sending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
};

export const RECIPIENT_STATUS_CLASS = toneClasses<BroadcastRecipientStatus>({
  PENDING: "neutral",
  SKIPPED: "neutral",
  QUEUED: "info",
  SENT: "info",
  DELIVERED: "success",
  READ: "success",
  FAILED: "critical",
});

export const RFM_LABEL: Record<RfmGroup, { label: string; hint: string }> = {
  champions: { label: "Champions", hint: "Bought recently and often" },
  loyal: { label: "Loyal", hint: "Buy regularly" },
  new: { label: "New", hint: "First orders, recently" },
  needs_attention: { label: "Needs attention", hint: "Bought a while ago, not often" },
  at_risk: { label: "At risk", hint: "Used to buy often, gone quiet" },
  hibernating: { label: "Hibernating", hint: "Long gone, bought rarely" },
  lost: { label: "Lost", hint: "Longest gone" },
};

export const VARIABLE_SOURCE_LABEL: Record<VariableSourceKind, string> = {
  static: "Fixed text",
  first_name: "First name",
  full_name: "Full name",
  phone: "Phone number",
  attribute: "Contact attribute",
  customer_name: "Store customer name",
  customer_email: "Store customer email",
};

/** Languages offered when creating a template; Meta's codes. */
export const TEMPLATE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "mr", label: "Marathi" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "pa", label: "Punjabi" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "id", label: "Indonesian" },
];

const VAR = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** Variables used in a text, in order of first appearance. Mirrors the server. */
export function variablesIn(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(VAR)) if (!seen.includes(match[1])) seen.push(match[1]);
  return seen;
}

/** The editor's draft as the customer would read it, examples filled in. */
export function renderDraft(draft: TemplateDraft): TemplateRender {
  const header = draft.header;
  const fill = (text: string, values: Record<string, string | undefined>) =>
    text.replace(VAR, (whole, v: string) => values[v]?.trim() || whole);
  return {
    header: header?.format === "TEXT" ? fill(header.text, { 1: header.example }) : null,
    headerFormat: header?.format ?? null,
    body: fill(draft.body.text, draft.body.examples),
    footer: draft.footer?.trim() || null,
    buttons: (draft.buttons ?? []).map((b) => (b.type === "COPY_CODE" ? "Copy code" : b.text || "Button")),
  };
}

/**
 * A template send's `components` from typed values. Mirrors sendComponents
 * on the server (campaigns/templates/template-components.ts); a media header
 * is not built here — the file goes as `headerMedia` and the server uploads it.
 */
export function buildSendComponents(
  params: Array<{ key: string; component: string; kind: string; name: string; buttonIndex?: number }>,
  format: "POSITIONAL" | "NAMED",
  values: Record<string, string>,
): unknown[] {
  const out: unknown[] = [];
  const header = params.find((p) => p.component === "header" && p.kind === "text");
  if (header) {
    out.push({ type: "header", parameters: [{ type: "text", ...(format === "NAMED" ? { parameter_name: header.name } : {}), text: values[header.key] ?? "" }] });
  }
  const body = params.filter((p) => p.component === "body");
  if (body.length) {
    out.push({
      type: "body",
      parameters: body.map((p) => ({ type: "text", ...(format === "NAMED" ? { parameter_name: p.name } : {}), text: values[p.key] ?? "" })),
    });
  }
  for (const p of params.filter((x) => x.component === "button")) {
    out.push(
      p.kind === "coupon_code"
        ? { type: "button", sub_type: "copy_code", index: p.buttonIndex, parameters: [{ type: "coupon_code", coupon_code: values[p.key] ?? "" }] }
        : { type: "button", sub_type: "url", index: String(p.buttonIndex), parameters: [{ type: "text", text: values[p.key] ?? "" }] },
    );
  }
  return out;
}

/**
 * A broadcast's template with its mapping shown in place of the variables:
 * fixed text as written, per-person values as their source, e.g. [First name].
 */
export function renderBroadcast(template: MessageTemplate, vars: BroadcastVariables): TemplateRender {
  const shown = (key: string) => {
    const s = vars.values[key];
    if (!s) return undefined;
    if (s.source === "static") return s.value;
    return s.source === "attribute" ? `[${s.value || "attribute"}]` : `[${VARIABLE_SOURCE_LABEL[s.source]}]`;
  };
  const examples: Record<string, string> = {};
  for (const p of template.params) {
    const value = shown(p.key);
    if (value && p.component === "body") examples[p.name] = value;
  }
  const header = template.draft.header?.format === "TEXT" ? { ...template.draft.header, example: shown("header") } : template.draft.header;
  return renderDraft({ ...template.draft, header, body: { ...template.draft.body, examples } });
}
