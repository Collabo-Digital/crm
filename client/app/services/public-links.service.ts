import axios from "axios";
import { apiUrl } from "~/lib/api-client";
import type { PublicCartLink, PublicOrderLink } from "~/types/api";

/**
 * The order and cart behind a link a customer got on WhatsApp. Plain axios
 * rather than apiClient, like the public bill: the pages are public, so they
 * must send no staff token, and a 401 must not start a session refresh.
 */
export const publicLinksService = {
  order: (token: string) =>
    axios.get<{ data: PublicOrderLink }>(apiUrl(`/public/links/order/${encodeURIComponent(token)}`), { timeout: 30_000 }).then((r) => r.data.data),
  cart: (token: string) =>
    axios.get<{ data: PublicCartLink }>(apiUrl(`/public/links/cart/${encodeURIComponent(token)}`), { timeout: 30_000 }).then((r) => r.data.data),
};
