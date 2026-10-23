import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { automationsService } from "~/services/automations.service";
import { pollWhile } from "~/lib/poll-while";
import type { AutomationPlatform, AutomationRunStatus, AutomationStats, AutomationStatus } from "~/types/api";

/** React Query key factory for automations and the inbox's own rules. */
export const automationKeys = {
  all: ["automations"] as const,
  list: (params: object) => [...automationKeys.all, "list", params] as const,
  detail: (id: string) => [...automationKeys.all, "detail", id] as const,
  stats: (id: string) => [...automationKeys.all, "stats", id] as const,
  runs: (id: string, params: object) => [...automationKeys.all, "runs", id, params] as const,
  posts: (channelId: string) => [...automationKeys.all, "posts", channelId] as const,
  starters: (channelId: string) => [...automationKeys.all, "starters", channelId] as const,
  inboxRules: () => ["inbox", "rules"] as const,
};

// Module-level on purpose (see poll-while.ts): runs keep moving while people reply or waits run out.
const pollWhileRunsInFlight = pollWhile<AutomationStats>((s) => !!s && (s.runs.PENDING + s.runs.RUNNING + s.runs.WAITING > 0));

export function useAutomations(params: { status?: AutomationStatus; platform?: AutomationPlatform; search?: string; page?: number }) {
  return useQuery({
    queryKey: automationKeys.list(params),
    queryFn: () => automationsService.list({ ...params, limit: 50 }),
    placeholderData: keepPreviousData,
  });
}

export function useAutomation(id: string | undefined) {
  return useQuery({ queryKey: automationKeys.detail(id ?? ""), queryFn: () => automationsService.get(id!), enabled: !!id });
}

export function useAutomationStats(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: automationKeys.stats(id ?? ""),
    queryFn: () => automationsService.stats(id!),
    enabled: !!id && enabled,
    refetchInterval: pollWhileRunsInFlight,
  });
}

export function useAutomationRuns(id: string | undefined, params: { page?: number; status?: AutomationRunStatus }, enabled = true) {
  return useQuery({
    queryKey: automationKeys.runs(id ?? "", params),
    queryFn: () => automationsService.runs(id!, params),
    enabled: !!id && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useInstagramPosts(channelId: string | undefined) {
  return useQuery({ queryKey: automationKeys.posts(channelId ?? ""), queryFn: () => automationsService.posts(channelId!), enabled: !!channelId, staleTime: 5 * 60_000 });
}

export function useConversationStarters(channelId: string | undefined) {
  return useQuery({ queryKey: automationKeys.starters(channelId ?? ""), queryFn: () => automationsService.starters(channelId!), enabled: !!channelId });
}

export function useInboxRules(enabled = true) {
  return useQuery({ queryKey: automationKeys.inboxRules(), queryFn: () => automationsService.inboxRules(), enabled });
}
