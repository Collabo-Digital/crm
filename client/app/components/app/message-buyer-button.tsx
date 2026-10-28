import { Loader2, MessageCircle } from "lucide-react";
import { useNavigate } from "react-router";
import { getCountryCallingCode, isSupportedCountry } from "libphonenumber-js/min";

import { Button } from "~/components/ui/button";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useStartChatMutation } from "~/hooks/use-inbox-mutations";
import { useSectionAccess } from "~/hooks/use-section-access";
import type { CustomerDetail } from "~/types/api";

/**
 * "Message on WhatsApp" from an order: opens the buyer's chat in the inbox,
 * starting it on the order's phone the way the inbox's New chat does. The
 * inbox then applies its own rule: outside 24 hours of the buyer's last
 * message, the first message has to be an approved template.
 *
 * Without a phone it still opens a WhatsApp chat already linked to the
 * customer. Viewers can open a chat but not start one, as in the inbox.
 */
export function MessageBuyerButton({
  phone,
  customerId,
  name,
  customer,
  countryCode,
}: {
  /** The customer's phone, else the shipping phone. */
  phone: string | null;
  customerId?: string;
  name?: string;
  /** The customer record, for a WhatsApp chat already linked to it. */
  customer?: CustomerDetail;
  /** ISO country of the shipping address, to read a number saved without its code. */
  countryCode?: string | null;
}) {
  const navigate = useNavigate();
  const { canAccess } = useSectionAccess();
  const { role } = useCurrentRole();
  const startChat = useStartChatMutation();
  if (!canAccess("/inbox")) return null;

  const linkedChat = customer?.chats.find((chat) => chat.platform === "WHATSAPP" && chat.conversationId);
  const canStart = role !== "VIEWER" && Boolean(phone);
  const blocked =
    canStart || linkedChat
      ? null
      : phone
        ? "Viewers can open a chat but not start one."
        : "There is no phone number on this order.";

  function open() {
    if (canStart && phone) {
      // A number saved without its country code is read in the address's country, else India.
      const iso = countryCode?.toUpperCase() ?? "IN";
      const dial = phone.trim().startsWith("+") || !isSupportedCountry(iso) ? undefined : getCountryCallingCode(iso);
      startChat.mutate(
        { phone, ...(dial ? { countryCode: dial } : {}), customerId, name },
        { onSuccess: (r) => navigate(`/inbox?c=${r.conversationId}`) },
      );
      return;
    }
    if (linkedChat) navigate(`/inbox?c=${linkedChat.conversationId}`);
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={Boolean(blocked) || startChat.isPending}
        title={blocked ?? undefined}
        onClick={open}
      >
        {startChat.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCircle className="size-3.5" />}
        Message on WhatsApp
      </Button>
      <p className="text-caption text-muted-foreground">
        {blocked ?? "Opens the chat in the inbox. After 24 hours without a reply from them, start with a template."}
      </p>
    </div>
  );
}
