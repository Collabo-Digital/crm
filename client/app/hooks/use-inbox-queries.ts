import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { inboxService } from "~/services/inbox.service";
import type { InboxContactQuery, InboxCursor, InboxFilters } from "~/types/api";

/** React Query key factory for the inbox. */
export const inboxKeys = {
  all: ["inbox"] as const,
  lists: () => [...inboxKeys.all, "list"] as const,
  list: (filters: InboxFilters) => [...inboxKeys.lists(), filters] as const,
  counts: () => [...inboxKeys.all, "counts"] as const,
  conversation: (id: string) => [...inboxKeys.all, "conversation", id] as const,
  messages: (id: string) => [...inboxKeys.all, "messages", id] as const,
  contacts: () => [...inboxKeys.all, "contacts"] as const,
  contactList: (query: InboxContactQuery) => [...inboxKeys.contacts(), "list", query] as const,
  contact: (id: string) => [...inboxKeys.contacts(), "detail", id] as const,
  contactTags: () => [...inboxKeys.contacts(), "tags"] as const,
  customerCandidates: (contactId: string, q: string) =>
    [...inboxKeys.contacts(), "customers", contactId, q] as const,
  me: () => [...inboxKeys.all, "me"] as const,
  members: () => [...inboxKeys.all, "members"] as const,
  teams: () => [...inboxKeys.all, "teams"] as const,
  quickReplies: (manage: boolean) => [...inboxKeys.all, "quick-replies", manage] as const,
  views: () => [...inboxKeys.all, "views"] as const,
};

/**
 * The live stream is the primary signal; this is the floor under it, for a
 * dropped stream or an event published while the tab was reconnecting.
 */
const SAFETY_REFETCH_MS = 60_000;

/** The conversation list, a page at a time, newest activity first. */
export function useInboxConversations(filters: InboxFilters) {
  return useInfiniteQuery({
    queryKey: inboxKeys.list(filters),
    queryFn: ({ pageParam }) => inboxService.listConversations(filters, pageParam),
    initialPageParam: null as InboxCursor | null,
    getNextPageParam: (last) => last.nextCursor,
    // Keep the previous filter's rows on screen (dimmed) while the next loads.
    placeholderData: keepPreviousData,
    refetchInterval: SAFETY_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

export function useInboxCounts(enabled = true) {
  return useQuery({
    queryKey: inboxKeys.counts(),
    queryFn: () => inboxService.counts(),
    enabled,
    refetchInterval: SAFETY_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

export function useInboxConversation(id: string | null) {
  return useQuery({
    queryKey: inboxKeys.conversation(id ?? ""),
    queryFn: () => inboxService.getConversation(id!),
    enabled: !!id,
  });
}

/**
 * A thread's messages. Page 0 is the newest; each further page is older, so
 * "load earlier" fetches the next page and the thread prepends it.
 */
export function useInboxMessages(id: string | null) {
  return useInfiniteQuery({
    queryKey: inboxKeys.messages(id ?? ""),
    queryFn: ({ pageParam }) => inboxService.listMessages(id!, pageParam),
    initialPageParam: null as InboxCursor | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!id,
    refetchInterval: SAFETY_REFETCH_MS,
  });
}

export function useInboxContacts(query: InboxContactQuery, enabled = true) {
  return useQuery({
    queryKey: inboxKeys.contactList(query),
    queryFn: () => inboxService.listContacts(query),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useContactTags(enabled = true) {
  return useQuery({ queryKey: inboxKeys.contactTags(), queryFn: () => inboxService.contactTags(), enabled });
}

export function useCustomerCandidates(contactId: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.customerCandidates(contactId, q),
    queryFn: () => inboxService.customerCandidates(contactId, q || undefined),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useInboxMe() {
  return useQuery({ queryKey: inboxKeys.me(), queryFn: () => inboxService.me() });
}

export function useInboxMembers(enabled = true) {
  return useQuery({
    queryKey: inboxKeys.members(),
    queryFn: () => inboxService.members(),
    enabled,
    // Presence changes as people open and close the inbox.
    refetchInterval: SAFETY_REFETCH_MS,
  });
}

export function useInboxTeams(enabled = true) {
  return useQuery({ queryKey: inboxKeys.teams(), queryFn: () => inboxService.listTeams(), enabled });
}

export function useQuickReplies(manage = false) {
  return useQuery({
    queryKey: inboxKeys.quickReplies(manage),
    queryFn: () => inboxService.listQuickReplies(manage),
  });
}

export function useInboxViews() {
  return useQuery({ queryKey: inboxKeys.views(), queryFn: () => inboxService.listViews() });
}
