import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { packingService } from "~/services/packing.service";
import type { PackingQueueParams } from "~/types/api";

export const packingKeys = {
  all: ["packing"] as const,
  queue: (params: PackingQueueParams) => [...packingKeys.all, "queue", params] as const,
  start: (orderId: string) => [...packingKeys.all, "start", orderId] as const,
  task: (taskId: string) => [...packingKeys.all, "task", taskId] as const,
  accuracy: (params: { from?: string; to?: string; warehouseId?: string }) =>
    [...packingKeys.all, "accuracy", params] as const,
};

export function usePackingQueue(params: PackingQueueParams) {
  return useQuery({
    queryKey: packingKeys.queue(params),
    queryFn: () => packingService.queue(params),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    // Other packers move orders between buckets; the queue is the floor's to-do list.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Opens the order for packing: its open task, or a new one. Called once per
 * visit and never refetched, because once the order is packed a second call
 * would start it over. Later reads go through `usePackTask`.
 */
export function usePackingStart(orderId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: packingKeys.start(orderId),
    queryFn: async () => {
      const task = await packingService.start(orderId);
      queryClient.setQueryData(packingKeys.task(task.id), task);
      return task;
    },
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** The task as it stands. Re-read on focus, since anyone who may pack can take over. */
export function usePackTask(taskId: string | undefined) {
  return useQuery({
    queryKey: packingKeys.task(taskId ?? ""),
    queryFn: () => packingService.task(taskId!),
    enabled: !!taskId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function usePackingAccuracy(params: { from?: string; to?: string; warehouseId?: string }) {
  return useQuery({
    queryKey: packingKeys.accuracy(params),
    queryFn: () => packingService.accuracy(params),
    placeholderData: keepPreviousData,
  });
}
