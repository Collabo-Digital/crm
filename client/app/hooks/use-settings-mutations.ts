import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizationSettingsService } from "~/services/organization-settings.service";
import { posService } from "~/services/pos.service";
import { settingsKeys } from "~/hooks/use-settings-queries";
import { posKeys } from "~/hooks/use-pos-queries";
import { handleMutationError, serverMessage } from "~/lib/handle-mutation-error";
import type {
  InvoiceSettings,
  PosSetup,
  StoreProfileSettings,
  UpdateInvoiceSettingsRequest,
  OrganizationSettingsResponse,
  UpdateProductSettingsRequest,
  UpdateOrderSettingsRequest,
  UpdateTaxSettingsRequest,
  UpdateInventorySettingsRequest,
  UpdateStoreProfileSettingsRequest,
} from "~/types/api";

/**
 * PATCH /organization/settings/products — merge-patch product settings.
 *
 * Uses an optimistic update so the toggle in the UI flips immediately on
 * click instead of waiting for the round-trip. On error we roll back to the
 * pre-mutation snapshot, on success we invalidate to pick up any server-side
 * canonicalization (defaults, future computed fields). The shared cache key
 * means two rapid mutations (e.g. flipping two different toggles back-to-back)
 * compose correctly — each sees the previous optimistic state as its baseline.
 */
export function useUpdateProductSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProductSettingsRequest) =>
      organizationSettingsService.updateProductSettings(data),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.all });
      const previous = queryClient.getQueryData<OrganizationSettingsResponse>(
        settingsKeys.all,
      );
      if (previous) {
        queryClient.setQueryData<OrganizationSettingsResponse>(
          settingsKeys.all,
          {
            ...previous,
            productSettings: { ...previous.productSettings, ...patch },
          },
        );
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsKeys.all, context.previous);
      }
      handleMutationError(error, "Failed to update product settings.");
    },
    onSuccess: () => {
      toast.success("Product settings updated.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

/**
 * PATCH /organization/settings/orders — merge-patch order settings.
 * Same optimistic / rollback pattern as the product version.
 */
export function useUpdateOrderSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderSettingsRequest) =>
      organizationSettingsService.updateOrderSettings(data),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.all });
      const previous = queryClient.getQueryData<OrganizationSettingsResponse>(
        settingsKeys.all,
      );
      if (previous) {
        queryClient.setQueryData<OrganizationSettingsResponse>(
          settingsKeys.all,
          {
            ...previous,
            orderSettings: { ...previous.orderSettings, ...patch },
          },
        );
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsKeys.all, context.previous);
      }
      handleMutationError(error, "Failed to update order settings.");
    },
    onSuccess: () => {
      toast.success("Order settings updated.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

/**
 * PATCH /organization/settings/inventory — merge-patch inventory settings.
 * Same optimistic / rollback pattern as the two above.
 *
 * Unlike products and orders, this endpoint is role-gated server-side
 * (`@Roles(...ORG_MANAGERS)`), so a VIEWER gets a 403 — `handleMutationError`
 * surfaces it and the optimistic update rolls back.
 */
export function useUpdateInventorySettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateInventorySettingsRequest) =>
      organizationSettingsService.updateInventorySettings(data),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.all });
      const previous = queryClient.getQueryData<OrganizationSettingsResponse>(
        settingsKeys.all,
      );
      if (previous) {
        queryClient.setQueryData<OrganizationSettingsResponse>(
          settingsKeys.all,
          {
            ...previous,
            inventorySettings: { ...previous.inventorySettings, ...patch },
          },
        );
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsKeys.all, context.previous);
      }
      handleMutationError(error, "Failed to update inventory settings.");
    },
    onSuccess: () => {
      toast.success("Inventory settings updated.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

/**
 * PATCH /organization/settings/tax — merge-patch GST/tax settings.
 *
 * Same optimistic shape as its siblings. Worth noting what these two values do:
 * the B2CL threshold moves invoices between GSTR-1 table 5 and table 7, and the
 * default UQC appears on every table 12 row — both change statutory output, so
 * the route is role-gated server-side.
 */
export function useUpdateTaxSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateTaxSettingsRequest) =>
      organizationSettingsService.updateTaxSettings(data),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.all });
      const previous = queryClient.getQueryData<OrganizationSettingsResponse>(
        settingsKeys.all,
      );
      if (previous) {
        queryClient.setQueryData<OrganizationSettingsResponse>(
          settingsKeys.all,
          { ...previous, taxSettings: { ...previous.taxSettings, ...patch } },
        );
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsKeys.all, context.previous);
      }
      handleMutationError(error, "Failed to update tax settings.");
    },
    onSuccess: () => {
      toast.success("Tax settings updated.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

/**
 * PATCH /organization/settings/store-profile - merge-patch the store profile.
 *
 * No optimistic update, unlike its four siblings, and that is deliberate: this
 * domain is a form with a Save button, not a row of toggles. The fields are
 * local state until the user submits, so there is no on-screen control racing
 * the request that an optimistic write would need to keep in sync - and
 * rolling back a whole form on error would discard what the user typed.
 *
 * Role-gated server-side (@Roles(...ORG_MANAGERS)), so a VIEWER or AGENT gets
 * a 403 that handleMutationError surfaces.
 */
export function useUpdateStoreProfileSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateStoreProfileSettingsRequest) =>
      organizationSettingsService.updateStoreProfileSettings(data),
    onError: (error) => {
      handleMutationError(error, "Failed to update store profile.");
    },
    onSuccess: () => {
      toast.success("Store profile updated.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}

/** Writes a domain the server just returned into the settings cache, so the page shows it before the refetch. */
function useSettingsCacheWrite() {
  const queryClient = useQueryClient();
  return (patch: Partial<OrganizationSettingsResponse>) =>
    queryClient.setQueryData<OrganizationSettingsResponse>(settingsKeys.all, (previous) =>
      previous ? { ...previous, ...patch } : previous,
    );
}

/** The invoice settings saved but the UPI ID did not; `cause` is the request's error. */
class UpiIdNotSaved extends Error {
  constructor(cause: unknown) {
    super("The UPI ID was not saved.", { cause });
  }
}

/**
 * The "Invoices & bills" Save: the invoice settings that changed, then the
 * UPI ID, which lives in the till's settings because the till uses it too.
 * One after the other, so a failure says which part didn't save. A form with
 * one Save, like the store profile, so no optimistic update; what the server
 * returns goes into the cache, and the form rebases onto it.
 */
export function useSaveInvoiceSettingsMutation() {
  const queryClient = useQueryClient();
  const write = useSettingsCacheWrite();
  return useMutation({
    mutationFn: async ({ invoice, upiId }: { invoice: UpdateInvoiceSettingsRequest | null; upiId?: string | null }) => {
      if (invoice) write({ invoiceSettings: await organizationSettingsService.updateInvoiceSettings(invoice) });
      if (upiId === undefined) return;
      try {
        const settings = await posService.updateSettings({ upiId });
        queryClient.setQueriesData<PosSetup>({ queryKey: [...posKeys.all, "setup"] }, (previous) =>
          previous ? { ...previous, settings } : previous,
        );
      } catch (error) {
        if (invoice) throw new UpiIdNotSaved(error);
        throw error;
      }
    },
    onSuccess: () => {
      toast.success("Invoice settings saved.");
    },
    onError: (error) =>
      error instanceof UpiIdNotSaved
        ? toast.error(`Your other changes were saved, but not the UPI ID. ${serverMessage(error.cause, "Try again.")}`)
        : handleMutationError(error, "The invoice settings were not saved."),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      void queryClient.invalidateQueries({ queryKey: [...posKeys.all, "setup"] });
    },
  });
}

/**
 * Logo and signature uploads save at once, outside the form's Save. Each
 * route answers with its whole domain, which goes straight into the cache.
 */
function useImageMutation<T extends StoreProfileSettings | InvoiceSettings, A>(
  mutationFn: (arg: A) => Promise<T>,
  domain: "storeProfileSettings" | "invoiceSettings",
  messages: { done: string; failed: string },
) {
  const queryClient = useQueryClient();
  const write = useSettingsCacheWrite();
  return useMutation({
    mutationFn,
    onSuccess: (saved) => {
      write({ [domain]: saved });
      toast.success(messages.done);
    },
    onError: (error) => handleMutationError(error, messages.failed),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
  });
}

export function useUploadLogoMutation() {
  return useImageMutation((file: File) => organizationSettingsService.uploadLogo(file), "storeProfileSettings", {
    done: "Logo uploaded.",
    failed: "The logo was not uploaded.",
  });
}

export function useRemoveLogoMutation() {
  return useImageMutation((_: void) => organizationSettingsService.removeLogo(), "storeProfileSettings", {
    done: "Logo removed.",
    failed: "The logo was not removed.",
  });
}

export function useUploadSignatureMutation() {
  return useImageMutation((file: File) => organizationSettingsService.uploadSignature(file), "invoiceSettings", {
    done: "Signature uploaded.",
    failed: "The signature was not uploaded.",
  });
}

export function useRemoveSignatureMutation() {
  return useImageMutation((_: void) => organizationSettingsService.removeSignature(), "invoiceSettings", {
    done: "Signature removed.",
    failed: "The signature was not removed.",
  });
}
