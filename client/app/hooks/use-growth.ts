import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { growthService } from "~/services/growth.service";

export const growthKeys = {
  all: ["growth"] as const,
  links: () => [...growthKeys.all, "links"] as const,
  widget: () => [...growthKeys.all, "widget"] as const,
};

export function useGrowthLinks() {
  return useQuery({ queryKey: growthKeys.links(), queryFn: growthService.links });
}

export function useSiteWidget() {
  return useQuery({ queryKey: growthKeys.widget(), queryFn: growthService.widget });
}

export function useCreateGrowthLinkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: growthService.createLink,
    onSuccess: () => {
      toast.success("Chat link created.");
      void queryClient.invalidateQueries({ queryKey: growthKeys.links() });
    },
    onError: (error) => handleMutationError(error, "The chat link was not created."),
  });
}

export function useArchiveGrowthLinkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: growthService.archiveLink,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: growthKeys.links() }),
    onError: (error) => handleMutationError(error, "The chat link was not removed."),
  });
}

export function useSaveWidgetMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: growthService.saveWidget,
    onSuccess: (view) => {
      toast.success("Website widget saved.");
      queryClient.setQueryData(growthKeys.widget(), view);
      void queryClient.invalidateQueries({ queryKey: growthKeys.links() });
    },
    onError: (error) => handleMutationError(error, "The website widget was not saved."),
  });
}
