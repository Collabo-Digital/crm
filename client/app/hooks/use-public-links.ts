import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { publicLinksService } from "~/services/public-links.service";

export const publicLinkKeys = {
  order: (token: string) => ["public-order-link", token] as const,
  cart: (token: string) => ["public-cart-link", token] as const,
};

// A wrong link stays wrong; only a dropped connection is worth retrying.
const retryUnlessRefused = (count: number, error: unknown) => {
  const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;
  return count < 2 && !(status >= 400 && status < 500);
};

/** The order behind a tracking link (/t/:token). A 404 means the link is wrong. */
export function usePublicOrderLink(token: string | undefined) {
  return useQuery({
    queryKey: publicLinkKeys.order(token ?? ""),
    queryFn: () => publicLinksService.order(token!),
    enabled: !!token,
    retry: retryUnlessRefused,
    refetchOnWindowFocus: false,
  });
}

/** The checkout behind a cart link (/c/:token). A 404 means the link is wrong. */
export function usePublicCartLink(token: string | undefined) {
  return useQuery({
    queryKey: publicLinkKeys.cart(token ?? ""),
    queryFn: () => publicLinksService.cart(token!),
    enabled: !!token,
    retry: retryUnlessRefused,
    refetchOnWindowFocus: false,
  });
}
