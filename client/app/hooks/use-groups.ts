import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { groupsService } from "~/services/groups.service";
import type { CreateGroupRequest } from "~/types/api";

export const groupKeys = {
  all: ["whatsapp-groups"] as const,
  detail: (id: string) => [...groupKeys.all, "detail", id] as const,
};

export function useGroups() {
  return useQuery({
    queryKey: groupKeys.all,
    queryFn: () => groupsService.list(),
    // A new group waits for Meta's webhook; look again until it arrives.
    refetchInterval: (query) => (query.state.data?.groups.some((g) => g.status === "CREATING" || g.status === "DELETING") ? 4000 : false),
  });
}

export function useGroup(id: string | null | undefined) {
  return useQuery({ queryKey: groupKeys.detail(id ?? ""), queryFn: () => groupsService.get(id!), enabled: !!id });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGroupRequest) => groupsService.create(body),
    onSuccess: () => {
      toast.success("Group requested. WhatsApp sends its invite link in a moment.");
      void queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
    onError: (error) => handleMutationError(error, "The group was not created."),
  });
}

type GroupAction =
  | { kind: "refresh" }
  | { kind: "update"; subject?: string; description?: string }
  | { kind: "reset-link" }
  | { kind: "remove-participant"; waId: string }
  | { kind: "decide"; requestId: string; approve: boolean }
  | { kind: "delete" };

const DONE: Record<GroupAction["kind"], string> = {
  refresh: "Group refreshed from WhatsApp.",
  update: "Group updated.",
  "reset-link": "New invite link made. The old one no longer works.",
  "remove-participant": "Removed from the group.",
  decide: "Done.",
  delete: "Deleting the group. Everyone, your business included, is removed.",
};

export function useGroupAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: GroupAction) => {
      switch (action.kind) {
        case "refresh":
          return groupsService.refresh(id);
        case "update":
          return groupsService.update(id, { subject: action.subject, description: action.description });
        case "reset-link":
          return groupsService.resetLink(id);
        case "remove-participant":
          return groupsService.removeParticipant(id, action.waId);
        case "decide":
          return groupsService.decide(id, action.requestId, action.approve);
        case "delete":
          return groupsService.remove(id);
      }
    },
    onSuccess: (_data, action) => {
      toast.success(action.kind === "decide" ? (action.approve ? "Request approved." : "Request declined.") : DONE[action.kind]);
      void queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
    onError: (error) => handleMutationError(error, "WhatsApp did not accept that."),
  });
}
