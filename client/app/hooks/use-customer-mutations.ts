import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { customerService } from "~/services/customer.service";
import { customerKeys } from "~/hooks/use-customer-queries";
import { inboxKeys } from "~/hooks/use-inbox-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { UpdateCustomerRequest } from "~/types/api";

/** Mutation hook for updating a customer's VIP level, notes, segments, or tags. */
export function useUpdateCustomerMutation(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateCustomerRequest) => customerService.update(customerId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.list() });
      toast.success("Customer updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update customer."),
  });
}

/** A chat linked to or unlinked from the customer: their page and the inbox's contact panel both change. */
function useInvalidateCustomerChats(customerId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.contacts() });
    void queryClient.invalidateQueries({ queryKey: [...inboxKeys.all, "conversation"] });
  };
}

export function useLinkChatMutation(customerId: string) {
  const invalidate = useInvalidateCustomerChats(customerId);
  return useMutation({
    mutationFn: (contactId: string) => customerService.linkChat(customerId, contactId),
    onSuccess: () => {
      toast.success("Chat linked to this customer.");
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The chat was not linked."),
  });
}

export function useUnlinkChatMutation(customerId: string) {
  const invalidate = useInvalidateCustomerChats(customerId);
  return useMutation({
    mutationFn: (contactId: string) => customerService.unlinkChat(customerId, contactId),
    onSuccess: () => {
      toast.success("Chat unlinked from this customer.");
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The chat was not unlinked."),
  });
}
