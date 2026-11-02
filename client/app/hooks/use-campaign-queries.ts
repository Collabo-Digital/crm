import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { campaignsService } from "~/services/campaigns.service";
import { pollWhile } from "~/lib/poll-while";
import { packBusy } from "~/lib/template-pack";
import type {
  Broadcast,
  BroadcastDetail,
  BroadcastRecipientStatus,
  BroadcastStatus,
  MessageTemplate,
  PaginatedResponse,
  SegmentDefinition,
  TemplatePackView,
} from "~/types/api";

/** React Query key factory for Campaigns. */
export const campaignKeys = {
  all: ["campaigns"] as const,
  overview: () => [...campaignKeys.all, "overview"] as const,
  templates: () => [...campaignKeys.all, "templates"] as const,
  templateList: (params: object) => [...campaignKeys.templates(), "list", params] as const,
  template: (id: string) => [...campaignKeys.templates(), "detail", id] as const,
  starters: () => [...campaignKeys.templates(), "starters"] as const,
  writer: () => [...campaignKeys.templates(), "writer"] as const,
  inboxTemplates: () => [...campaignKeys.templates(), "inbox"] as const,
  pack: () => [...campaignKeys.templates(), "pack"] as const,
  segments: () => [...campaignKeys.all, "segments"] as const,
  segment: (id: string) => [...campaignKeys.segments(), "detail", id] as const,
  segmentPreview: (definition: SegmentDefinition) => [...campaignKeys.segments(), "preview", definition] as const,
  rfm: () => [...campaignKeys.segments(), "rfm"] as const,
  broadcasts: () => [...campaignKeys.all, "broadcasts"] as const,
  broadcastList: (params: object) => [...campaignKeys.broadcasts(), "list", params] as const,
  broadcast: (id: string) => [...campaignKeys.broadcasts(), "detail", id] as const,
  broadcastPreview: (id: string) => [...campaignKeys.broadcasts(), "preview", id] as const,
  recipients: (id: string, params: object) => [...campaignKeys.broadcasts(), "recipients", id, params] as const,
  rates: () => [...campaignKeys.all, "rates"] as const,
};

const isLive = (status?: BroadcastStatus) => status === "SENDING" || status === "SCHEDULED";

// Module-level on purpose: each poller keeps its own "busy since" clock (see poll-while.ts).
/// Meta's review takes minutes to hours; the webhook updates the row and this shows it.
const pollWhileReviewing = pollWhile<MessageTemplate[]>((rows) => rows?.some((t) => t.status === "PENDING") ?? false);
// Setting up or repairing the pack answers before the work starts, so a
// request counts as busy for a couple of minutes whatever the answer said.
let packRequestedAt = 0;
export const notePackRequested = () => {
  packRequestedAt = Date.now();
};
const packChanging = (view: TemplatePackView | undefined) => packBusy(view) || Date.now() - packRequestedAt < 2 * 60_000;
const pollWhilePackBusy = pollWhile<TemplatePackView>(packChanging);
/// Where the merchant watches the pack come together: Meta can take up to a day.
const pollUntilPackSettled = pollWhile<TemplatePackView>(packChanging, { giveUpAfterMs: 24 * 3600_000 });
const pollWhileAnySending = pollWhile<PaginatedResponse<Broadcast>>((page) => page?.data.some((b) => isLive(b.status)) ?? false);
/// Sending, and the delivery receipts that keep arriving for a while after it.
const pollWhileDelivering = pollWhile<BroadcastDetail>(
  (b) => isLive(b?.status) || (b?.status === "COMPLETED" && !!b.completedAt && Date.now() - new Date(b.completedAt).getTime() < 3600_000),
);

export function useCampaignsOverview() {
  return useQuery({ queryKey: campaignKeys.overview(), queryFn: () => campaignsService.overview() });
}

export function useTemplates(params: { status?: string; category?: string; search?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.templateList(params),
    queryFn: () => campaignsService.listTemplates(params),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: pollWhileReviewing,
  });
}

export function useTemplate(id: string | undefined) {
  return useQuery({ queryKey: campaignKeys.template(id ?? ""), queryFn: () => campaignsService.getTemplate(id!), enabled: !!id });
}

/**
 * Collabo's recommended templates and where each stands. `untilSettled` keeps
 * polling past 15 minutes while Meta reviews. A role without Campaigns access
 * gets a 403, which callers treat as "nothing to show".
 */
export function useTemplatePack({ enabled = true, untilSettled = false }: { enabled?: boolean; untilSettled?: boolean } = {}) {
  return useQuery({
    queryKey: campaignKeys.pack(),
    queryFn: () => campaignsService.templatePack(),
    enabled,
    refetchInterval: untilSettled ? pollUntilPackSettled : pollWhilePackBusy,
  });
}

export function useTemplateStarters() {
  return useQuery({ queryKey: campaignKeys.starters(), queryFn: () => campaignsService.starters(), staleTime: Infinity });
}

export function useTemplateWriter() {
  return useQuery({ queryKey: campaignKeys.writer(), queryFn: () => campaignsService.writerStatus(), staleTime: Infinity });
}

export function useInboxTemplates(enabled: boolean) {
  return useQuery({ queryKey: campaignKeys.inboxTemplates(), queryFn: () => campaignsService.inboxTemplates(), enabled });
}

export function useSegments() {
  return useQuery({ queryKey: campaignKeys.segments(), queryFn: () => campaignsService.listSegments() });
}

export function useSegment(id: string | undefined) {
  return useQuery({ queryKey: campaignKeys.segment(id ?? ""), queryFn: () => campaignsService.getSegment(id!), enabled: !!id });
}

export function useSegmentPreview(definition: SegmentDefinition | null) {
  return useQuery({
    queryKey: campaignKeys.segmentPreview(definition ?? { match: "all", rules: [] }),
    queryFn: () => campaignsService.previewSegment(definition!),
    enabled: !!definition && definition.rules.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRfmSummary() {
  return useQuery({ queryKey: campaignKeys.rfm(), queryFn: () => campaignsService.rfmSummary() });
}

export function useBroadcasts(params: { status?: BroadcastStatus; search?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: campaignKeys.broadcastList(params),
    queryFn: () => campaignsService.listBroadcasts(params),
    placeholderData: keepPreviousData,
    refetchInterval: pollWhileAnySending,
  });
}

export function useBroadcast(id: string | undefined) {
  return useQuery({
    queryKey: campaignKeys.broadcast(id ?? ""),
    queryFn: () => campaignsService.getBroadcast(id!),
    enabled: !!id,
    refetchInterval: pollWhileDelivering,
  });
}

/** The review: counts, cost and warnings. Fetched when the review step opens. */
export function useBroadcastPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: campaignKeys.broadcastPreview(id),
    queryFn: () => campaignsService.previewBroadcast(id),
    enabled,
    staleTime: 0,
  });
}

export function useBroadcastRecipients(id: string, params: { status?: BroadcastRecipientStatus; page?: number; limit?: number }) {
  return useQuery({
    queryKey: campaignKeys.recipients(id, params),
    queryFn: () => campaignsService.recipients(id, params),
    placeholderData: keepPreviousData,
  });
}

export function useMessageRates() {
  return useQuery({ queryKey: campaignKeys.rates(), queryFn: () => campaignsService.listRates() });
}
