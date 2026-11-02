import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { posKeys } from "~/hooks/use-pos-queries";
import { orderKeys } from "~/hooks/use-order-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { posService } from "~/services/pos.service";
import type { PosPaymentInput, PosStaffRole } from "~/types/api";

export function useUpdatePosSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: posService.updateSettings,
    onSuccess: () => {
      toast.success("Point of sale settings saved.");
      void queryClient.invalidateQueries({ queryKey: [...posKeys.all, "setup"] });
    },
    onError: (error) => handleMutationError(error, "The settings were not saved."),
  });
}

function useStaffInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: posKeys.staff() });
    void queryClient.invalidateQueries({ queryKey: [...posKeys.all, "setup"] });
  };
}

/** Errors stay with the form, which shows the server's sentence beside the PIN. */
export function useCreatePosStaffMutation() {
  const invalidate = useStaffInvalidation();
  return useMutation({
    mutationFn: (data: { name: string; role: PosStaffRole; pin: string }) => posService.createStaff(data),
    onSuccess: (staff) => {
      toast.success(`${staff.name} can now unlock point of sale.`);
      invalidate();
    },
  });
}

export function useUpdatePosStaffMutation() {
  const invalidate = useStaffInvalidation();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; role?: PosStaffRole; pin?: string; isActive?: boolean }) =>
      posService.updateStaff(id, data),
    onSuccess: invalidate,
  });
}

/** The till shows a wrong PIN on the pad itself, so no toast here. */
export function usePosUnlockMutation() {
  return useMutation({ mutationFn: posService.unlock });
}

export function usePosApproveMutation() {
  return useMutation({ mutationFn: posService.approve });
}

/** Errors are shown in the payment dialog, which keeps the cart for a retry. */
export function useCreatePosSaleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: posService.createSale,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...posKeys.all, "products"] });
      void queryClient.invalidateQueries({ queryKey: [...posKeys.all, "setup"] });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

export function useCollectPosPaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...data }: PosPaymentInput & { orderId: string; staffToken?: string }) =>
      posService.collectPayment(orderId, data),
    onSuccess: (_, { orderId }) => {
      void queryClient.invalidateQueries({ queryKey: posKeys.receipt(orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

/** The answer and any refusal are shown on the bill's delivery row, not as a toast. */
export function useSendPosBillMutation() {
  return useMutation({
    mutationFn: ({ orderId, ...data }: { orderId: string; phone?: string; staffToken?: string }) => posService.sendBill(orderId, data),
  });
}
