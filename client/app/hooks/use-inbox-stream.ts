import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "~/lib/api-client";
import { callKeys } from "~/hooks/use-calls";
import { inboxKeys } from "~/hooks/use-inbox-queries";
import { useAuthStore } from "~/stores/auth.store";
import type { InboxStreamEvent } from "~/types/api";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";
/// Events arrive in bursts (a send is message.created + conversation.updated);
/// one refetch per burst is plenty.
const FLUSH_MS = 250;
/// At most one refetch of the open thread per this long.
const THREAD_EVERY_MS = 1_500;
/// At most one refetch of the list (every loaded page) and counts per this
/// long. A broadcast streams thousands of events, and these reads share a
/// per-member rate limit with every open tab.
const LIST_EVERY_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
/// The server opens each stream with a newline at once and pings every 25 s.
/// A stream that has said nothing within FIRST_BYTE_MS of opening, or for
/// QUIET_MS since, is being held back on the way (Cloudflare quick tunnels and
/// some office proxies buffer server-sent events), so what is on screen is
/// refetched every POLL_MS instead, until the stream delivers again.
const FIRST_BYTE_MS = 5_000;
const QUIET_MS = 35_000;
const POLL_MS = 5_000;

/**
 * Runs `fn` soon after `request()`, then at most once per `everyMs`: the
 * first event of a burst shows at once, the rest of the burst in one go.
 */
export function paced(fn: () => void, everyMs: number, soonMs = FLUSH_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = -Infinity;
  return {
    request() {
      timer ??= setTimeout(() => {
        timer = null;
        lastAt = Date.now();
        fn();
      }, Math.max(soonMs, lastAt + everyMs - Date.now()));
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Keep the open inbox live.
 *
 * The server streams which conversation changed (`/inbox/stream`, server-sent
 * events) and this refetches exactly what each event names. A plain
 * EventSource cannot send the Bearer token, so the stream is read with
 * fetch. On a drop it reconnects with backoff and refetches everything, since
 * whatever happened in between was missed. While connected, the server counts
 * this member as present.
 *
 * Returns whether the stream is currently connected.
 */
export function useInboxStream(enabled = true): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    const changedConversations = new Set<string>();
    const changedThreads = new Set<string>();
    let openedAt = Date.now();
    let lastByteAt: number | null = null;
    const poll = setInterval(() => {
      const quiet = lastByteAt === null ? Date.now() - openedAt > FIRST_BYTE_MS : Date.now() - lastByteAt > QUIET_MS;
      if (!quiet || document.visibilityState !== "visible") return;
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      void queryClient.invalidateQueries({ queryKey: callKeys.live });
    }, POLL_MS);

    // Only what is on screen refetches: invalidating an inactive query just marks it stale.
    const threads = paced(() => {
      for (const id of changedConversations) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(id) });
      }
      for (const id of changedThreads) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(id) });
      }
      changedConversations.clear();
      changedThreads.clear();
    }, THREAD_EVERY_MS);
    const lists = paced(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.counts() });
    }, LIST_EVERY_MS);

    const handle = (event: InboxStreamEvent) => {
      // A call rang, was answered or ended: the call dock checks at once.
      if (event.type === "call.updated") void queryClient.invalidateQueries({ queryKey: callKeys.live });
      // A delivery or read receipt changes one bubble's ticks, not the list or the counts.
      if (event.type === "message.updated") {
        changedThreads.add(event.conversationId);
      } else {
        changedConversations.add(event.conversationId);
        if (event.type !== "conversation.updated") changedThreads.add(event.conversationId);
        lists.request();
      }
      threads.request();
    };

    const read = async (body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        lastByteAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data) as Partial<InboxStreamEvent>;
            // Heartbeats carry no type.
            if (event.type && event.conversationId) handle(event as InboxStreamEvent);
          } catch {
            // A malformed block is skipped; the next one is independent.
          }
        }
      }
    };

    const run = async () => {
      let attempt = 0;
      let hadConnection = false;
      while (!stopped) {
        controller = new AbortController();
        openedAt = Date.now();
        lastByteAt = null;
        try {
          const res = await fetch(`${BASE_URL}/inbox/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${useAuthStore.getState().accessToken ?? ""}`,
            },
            credentials: "include",
            signal: controller.signal,
          });
          if (res.status === 401) {
            // Any API call refreshes an expired token; the next attempt uses it.
            await apiClient.get("/inbox/me").catch(() => undefined);
            throw new Error("stream unauthorized");
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          attempt = 0;
          setConnected(true);
          if (hadConnection) void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
          hadConnection = true;
          await read(res.body);
        } catch {
          // Dropped, refused or aborted: fall through to the retry below.
        }
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };

    void run();
    return () => {
      stopped = true;
      clearInterval(poll);
      controller?.abort();
      threads.cancel();
      lists.cancel();
    };
  }, [enabled, queryClient]);

  return connected;
}
