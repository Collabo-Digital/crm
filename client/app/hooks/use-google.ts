import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { googleService } from "~/services/google.service";
import type { GoogleIntegration } from "~/types/api";

export const googleKeys = {
  all: ["google"] as const,
  status: () => [...googleKeys.all, "status"] as const,
  columns: (id: string) => [...googleKeys.all, "columns", id] as const,
};

export function useGoogleIntegration(enabled = true) {
  return useQuery({ queryKey: googleKeys.status(), queryFn: googleService.status, enabled, retry: false });
}

/** A sheet's header row, read from Google. */
export function useSheetColumns(sheetId: string | undefined) {
  return useQuery({ queryKey: googleKeys.columns(sheetId ?? ""), queryFn: () => googleService.columns(sheetId!), enabled: !!sheetId, retry: false, staleTime: 60_000 });
}

type SheetAction =
  | { kind: "complete"; code: string; state: string }
  | { kind: "create"; title: string; headers: string[] }
  | { kind: "picked"; spreadsheetId: string }
  | { kind: "remove"; id: string }
  | { kind: "disconnect" };

export function useGoogleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: SheetAction): Promise<GoogleIntegration | null> => {
      if (action.kind === "complete") return googleService.complete(action.code, action.state);
      if (action.kind === "create") return googleService.createSheet({ title: action.title, headers: action.headers });
      if (action.kind === "picked") return googleService.addPicked(action.spreadsheetId);
      if (action.kind === "remove") return googleService.removeSheet(action.id);
      await googleService.disconnect();
      return null;
    },
    onSuccess: (data, action) => {
      if (data) queryClient.setQueryData(googleKeys.status(), data);
      else void queryClient.invalidateQueries({ queryKey: googleKeys.all });
      toast.success(
        { complete: "Google connected.", create: "Sheet created in your Google Drive.", picked: "Sheet added.", remove: "Sheet removed from Collabo. It stays in your Google Drive.", disconnect: "Google disconnected." }[action.kind],
      );
    },
    onError: (error) => handleMutationError(error, "Google Sheets was not updated."),
  });
}
