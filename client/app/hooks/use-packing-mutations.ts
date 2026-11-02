import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { orderKeys } from "~/hooks/use-order-queries";
import { packingKeys } from "~/hooks/use-packing-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { packingService } from "~/services/packing.service";
import type { PackConfirmReason, PackHoldReason, PackProblemReason, PackTask } from "~/types/api";

/**
 * A request that never got an answer (a dropped connection on the warehouse
 * Wi-Fi) is sent again with the same clientScanId, which the server treats as
 * the same scan. Anything the server did answer is not repeated.
 */
function retryUnanswered(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && isAxiosError(error) && !error.response;
}

/** Every action answers with the whole task: put it on screen and mark the lists stale. */
function useStoreTask() {
  const queryClient = useQueryClient();
  return (task: PackTask) => {
    queryClient.setQueryData(packingKeys.task(task.id), task);
    // Not packingKeys.all: that would re-run start, which happens once a visit.
    void queryClient.invalidateQueries({ queryKey: [...packingKeys.all, "queue"] });
    void queryClient.invalidateQueries({ queryKey: [...packingKeys.all, "accuracy"] });
    void queryClient.invalidateQueries({ queryKey: orderKeys.detail(task.orderId) });
  };
}

/** Scans go one at a time from the page, which shows the result itself. */
export function useScanMutation(taskId: string) {
  const store = useStoreTask();
  return useMutation({
    mutationFn: (vars: { code: string; clientScanId: string }) => packingService.scan(taskId, vars),
    retry: retryUnanswered,
    onSuccess: (res) => store(res.task),
  });
}

/** Only writes that carry a clientScanId are safe to send twice. */
function useTaskWrite<V>(write: (vars: V) => Promise<PackTask>, fallback: string, { idempotent = false } = {}) {
  const store = useStoreTask();
  return useMutation({
    mutationFn: write,
    retry: idempotent ? retryUnanswered : false,
    onSuccess: store,
    onError: (error) => handleMutationError(error, fallback),
  });
}

/**
 * Every change a packer makes to one task. Line actions are refused (409)
 * unless the task is being packed, so a held task is resumed first.
 */
export function usePackTaskActions(taskId: string) {
  return {
    confirm: useTaskWrite(
      (v: { lineId: string; qty: number; reason: PackConfirmReason; clientScanId: string }) =>
        packingService.confirm(taskId, v.lineId, { qty: v.qty, reason: v.reason, clientScanId: v.clientScanId }),
      "The item was not confirmed. Try again.",
      { idempotent: true },
    ),
    count: useTaskWrite(
      (v: { lineId: string; packed: number; clientScanId: string }) =>
        packingService.count(taskId, v.lineId, { packed: v.packed, clientScanId: v.clientScanId }),
      "The count was not saved. Try again.",
      { idempotent: true },
    ),
    undo: useTaskWrite(
      (v: { lineId: string; clientScanId: string }) =>
        packingService.undo(taskId, v.lineId, { clientScanId: v.clientScanId }),
      "Nothing was taken off. Try again.",
      { idempotent: true },
    ),
    reportProblem: useTaskWrite(
      (v: { lineId: string; reason: PackProblemReason; qty: number }) =>
        packingService.reportProblem(taskId, v.lineId, { reason: v.reason, qty: v.qty }),
      "The problem was not saved. Try again.",
    ),
    clearProblem: useTaskWrite(
      (v: { lineId: string }) => packingService.clearProblem(taskId, v.lineId),
      "The problem was not cleared. Try again.",
    ),
    hold: useTaskWrite(
      (v: { reason: PackHoldReason; note?: string }) => packingService.hold(taskId, v),
      "The order was not put on hold. Try again.",
    ),
    resume: useTaskWrite(() => packingService.resume(taskId), "Packing did not resume. Try again."),
    finish: useTaskWrite(
      (mode: "all" | "partial") => packingService.finish(taskId, mode),
      "The order was not marked packed. Try again.",
    ),
    cancel: useTaskWrite(() => packingService.cancel(taskId), "Packing was not cleared. Try again."),
  };
}

/** Scanning a packing slip: which order it belongs to. */
export function useLookupMutation() {
  return useMutation({ mutationFn: (code: string) => packingService.lookup(code) });
}
