import { useNavigate } from "react-router";
import { ChevronRight, ListChecks, Mail, MessageCircle } from "lucide-react";

import { showSetupGuide } from "~/components/app/get-started-card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useCurrentRole } from "~/hooks/use-current-role";
import { SUPPORT_EMAIL, supportEmailLink, supportWhatsAppLink } from "~/lib/support";
import { useAuthStore } from "~/stores/auth.store";

const row = "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-offset-[-2px]";

/** Help and support, from the account menu and the phone's More sheet. */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { role } = useCurrentRole();
  const orgId = useAuthStore((s) => s.currentOrgId);
  const canSetUp = role === "OWNER" || role === "ADMIN";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Help and support</DialogTitle>
          <DialogDescription>Ask us anything about setting up or using Collabo.</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          <a href={supportEmailLink("Help with Collabo")} className={row}>
            <Mail className="size-5 shrink-0 text-brand-strong" strokeWidth={1.7} />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">Email support</span>
              <span className="block truncate text-caption text-muted-foreground">{SUPPORT_EMAIL}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </a>
          {supportWhatsAppLink && (
            <a href={supportWhatsAppLink} target="_blank" rel="noopener noreferrer" className={row}>
              <MessageCircle className="size-5 shrink-0 text-brand-strong" strokeWidth={1.7} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">Chat with us on WhatsApp</span>
                <span className="block text-caption text-muted-foreground">Opens WhatsApp</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </a>
          )}
          {canSetUp && (
            <button
              type="button"
              className={row}
              onClick={() => {
                showSetupGuide(orgId);
                onOpenChange(false);
                navigate("/dashboard");
              }}
            >
              <ListChecks className="size-5 shrink-0 text-brand-strong" strokeWidth={1.7} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">Setup guide</span>
                <span className="block text-caption text-muted-foreground">Get your store live, step by step, on the dashboard</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
