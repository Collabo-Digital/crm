import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { isAxiosError } from "axios";

import { useCreateBroadcastMutation } from "~/hooks/use-campaign-mutations";

export function meta() {
  return [{ title: "New broadcast | Collabo CRM" }];
}

/**
 * Starts a draft and hands over to its page. Drafts live on the server so a
 * half-built broadcast survives a reload or a switch of device.
 */
export default function NewBroadcastPage() {
  const navigate = useNavigate();
  const create = useCreateBroadcastMutation();
  const started = useRef(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    // Strict mode runs effects twice in development; one draft is enough. The
    // promise, not mutate's callbacks, carries the result: those are dropped
    // when strict mode remounts the page.
    if (started.current) return;
    started.current = true;
    create
      .mutateAsync({ name: "Untitled broadcast" })
      .then((b) => navigate(`/campaigns/broadcasts/${b.id}`, { replace: true }))
      .catch(setFailure);
  }, [create, navigate]);

  if (failure) {
    const message = isAxiosError(failure) ? (failure.response?.data as { message?: string } | undefined)?.message : null;
    return (
      <div className="space-y-2 py-10 text-center">
        <p className="text-body text-foreground">{message ?? "The broadcast could not be started."}</p>
        <Link to="/settings/channels" className="text-caption font-medium underline">
          Settings → Channels
        </Link>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-caption text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Starting a draft…
    </div>
  );
}
