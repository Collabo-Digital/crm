import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { automationKeys } from "~/hooks/use-automation-queries";
import { campaignKeys } from "~/hooks/use-campaign-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { automationsService } from "~/services/automations.service";
import { inboxService } from "~/services/inbox.service";
import type {
  AutomationDetail,
  AutomationPlatform,
  AutomationSettings,
  AutomationStep,
  CartDiscount,
  ConversationStarters,
  InboxRulesSettings,
  TemplatePackView,
} from "~/types/api";

function useRefresh() {
  const queryClient = useQueryClient();
  return (detail?: AutomationDetail) => {
    if (detail) queryClient.setQueryData(automationKeys.detail(detail.id), detail);
    void queryClient.invalidateQueries({ queryKey: automationKeys.all });
  };
}

/** Create, then (for a playbook) fill in its steps. */
export function useCreateAutomationMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (data: { name: string; platform: AutomationPlatform; channelId: string; steps?: AutomationStep[] }) => {
      const created = await automationsService.create({ name: data.name, platform: data.platform, channelId: data.channelId });
      return data.steps ? automationsService.saveDefinition(created.id, data.steps) : created;
    },
    onSuccess: (detail) => refresh(detail),
    onError: (error) => handleMutationError(error, "The automation was not created."),
  });
}

export function useSaveAutomationMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, steps, settings }: { id: string; steps: AutomationStep[]; settings?: AutomationSettings }) =>
      automationsService.saveDefinition(id, steps, settings),
    onSuccess: (detail) => refresh(detail),
    onError: (error) => handleMutationError(error, "The draft was not saved."),
  });
}

export function useRenameAutomationMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => automationsService.rename(id, { name }),
    onSuccess: (detail) => refresh(detail),
    onError: (error) => handleMutationError(error, "The name was not saved."),
  });
}

/** Publish, pause or resume. A publish that has issues comes back 422 with them; the page shows them. */
export function useAutomationLifecycleMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "publish" | "pause" | "resume" }) => automationsService[action](id),
    onSuccess: (detail, { action }) => {
      refresh(detail);
      toast.success(action === "publish" ? "Published. It runs from now on." : action === "pause" ? "Paused. Nothing new starts, and runs waiting inside it stop when they wake." : "Running again.");
    },
    onError: (error, { action }) => {
      // Issues are listed on the page instead of a toast.
      if ((error as { response?: { status?: number } }).response?.status === 422) return;
      handleMutationError(error, action === "publish" ? "It was not published." : "That did not work.");
    },
  });
}

export function useDuplicateAutomationMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => automationsService.duplicate(id),
    onSuccess: (detail) => {
      refresh(detail);
      toast.success(`Copied as “${detail.name}”.`);
    },
    onError: (error) => handleMutationError(error, "It was not copied."),
  });
}

export function useArchiveAutomationMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => automationsService.archive(id),
    onSuccess: () => {
      refresh();
      toast.success("Archived. Its history is kept.");
    },
    onError: (error) => handleMutationError(error, "It was not archived."),
  });
}

/** Turns on the recommended WhatsApp messages; the page reports what went live and what waits for Meta. */
export function useTurnOnPackMutation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (keys?: string[]) => automationsService.turnOnPack(keys),
    onSuccess: () => refresh(),
    onError: (error) => handleMutationError(error, "The automations were not turned on."),
  });
}

/** Saves (or, with null, removes) the discount cart recovery's third reminder offers. */
export function useSaveCartDiscountMutation() {
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cartDiscount: CartDiscount | null) => automationsService.saveCartDiscount({ cartDiscount }),
    onSuccess: ({ cartDiscount }) => {
      toast.success(cartDiscount ? `Saved. The third cart reminder offers ${cartDiscount.text} off with ${cartDiscount.code}.` : "Removed. Cart recovery sends two reminders.");
      queryClient.setQueryData<TemplatePackView>(campaignKeys.pack(), (view) => (view?.pack ? { ...view, pack: { ...view.pack, cartDiscount } } : view));
      refresh();
    },
    onError: (error) => handleMutationError(error, "The cart discount was not saved."),
  });
}

export function useTestAutomationMutation() {
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; text?: string; reply?: string; order?: "cod" | "prepaid" }) => automationsService.test(id, data),
    onError: (error) => handleMutationError(error, "The test did not run."),
  });
}

export function useSaveStartersMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, starters }: { channelId: string; starters: Omit<ConversationStarters, "platform" | "pushedAt"> }) =>
      automationsService.saveStarters(channelId, starters),
    onSuccess: (data, { channelId }) => {
      queryClient.setQueryData(automationKeys.starters(channelId), data);
      toast.success("Saved and sent to Meta. People may need to open a new chat to see the change.");
    },
    onError: (error) => handleMutationError(error, "The conversation starters were not saved."),
  });
}

export function useSaveInboxRulesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: InboxRulesSettings) => automationsService.saveInboxRules(settings),
    onSuccess: (data) => {
      queryClient.setQueryData(automationKeys.inboxRules(), data);
      toast.success("Inbox rules saved.");
    },
    onError: (error) => handleMutationError(error, "The inbox rules were not saved."),
  });
}

/** Connect, disconnect, change settings of, or sync a WhatsApp number's catalog. */
export function useCatalogMutation(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: { kind: "connect"; catalogId: string } | { kind: "disconnect" } | { kind: "settings"; catalogVisible?: boolean; cartEnabled?: boolean } | { kind: "sync" }) => {
      switch (action.kind) {
        case "connect":
          return { view: await automationsService.connectCatalog(channelId, action.catalogId) };
        case "disconnect":
          return { view: await automationsService.disconnectCatalog(channelId) };
        case "settings":
          return { view: await automationsService.catalogSettings(channelId, { catalogVisible: action.catalogVisible, cartEnabled: action.cartEnabled }) };
        case "sync": {
          const r = await automationsService.syncCatalog(channelId);
          return { view: r.view, sync: r };
        }
      }
    },
    onSuccess: (result, action) => {
      queryClient.setQueryData(automationKeys.catalog(channelId), result.view);
      if (action.kind === "sync" && "sync" in result && result.sync) {
        const r = result.sync;
        toast.success(`Catalog updated: ${r.sent} sent, ${r.removed} removed${r.skipped ? `, ${r.skipped} need attention` : ""}${r.errors ? `, ${r.errors} refused by Meta` : ""}.`);
      } else if (action.kind === "connect") toast.success("Catalog connected.");
      void queryClient.invalidateQueries({ queryKey: ["commerce", "products"] });
    },
    onError: (error) => handleMutationError(error, "The catalog was not updated."),
  });
}

export function useDraftFromCartMutation(conversationId: string) {
  return useMutation({
    mutationFn: (messageId: string) => inboxService.draftFromCart(conversationId, messageId),
    onError: (error) => handleMutationError(error, "The draft order was not created."),
  });
}
