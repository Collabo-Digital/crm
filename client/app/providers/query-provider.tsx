import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useMediaQuery } from "~/hooks/use-media-query";
import { queryClient } from "~/lib/query-client";
import { startSessionCacheGuard } from "~/lib/session-cache";

// Before the first query runs, so no session change can slip past it.
startSessionCacheGuard();

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const desktop = useMediaQuery("(min-width: 768px)");
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {import.meta.env.DEV && desktop && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
