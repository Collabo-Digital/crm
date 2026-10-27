import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebounced } from "~/hooks/use-debounced";
import { organizationSettingsService } from "~/services/organization-settings.service";
import type { InvoiceSample, UpdateInvoiceSettingsRequest } from "~/types/api";

/** React Query key factory for organization-settings queries. */
export const settingsKeys = {
  all: ["organization-settings"] as const,
};

/** Fetch all domain settings for the current org. */
export function useOrganizationSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => organizationSettingsService.get(),
  });
}

/**
 * The "Invoices & bills" preview: a sample document drawn by the server with
 * the unsaved form over the saved settings. Keyed on the form's content and
 * debounced, so typing sends one request when it pauses, and a sample already
 * drawn for this form comes back from the cache. The last PDF stays on screen
 * while the next one is made.
 */
export function useInvoicePreview(sample: InvoiceSample, settings: UpdateInvoiceSettingsRequest, enabled: boolean) {
  const settingsKey = useDebounced(JSON.stringify(settings), 500);
  return useQuery({
    queryKey: [...settingsKeys.all, "invoice-preview", sample, settingsKey] as const,
    queryFn: ({ signal }) =>
      organizationSettingsService.previewInvoice({ sample, settings: JSON.parse(settingsKey) as UpdateInvoiceSettingsRequest }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
