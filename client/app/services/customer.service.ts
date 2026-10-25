import { apiClient } from "~/lib/api-client";
import type {
  PaginatedResponse,
  Customer,
  CustomerDetail,
  CustomerListParams,
  CustomerStatsResponse,
  UpdateCustomerRequest,
} from "~/types/api";

/**
 * Service layer for customer API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const customerService = {
  list: (params?: CustomerListParams) =>
    apiClient.get<PaginatedResponse<Customer>>("/customers", { params }).then((response) => response.data),

  get: (id: string) =>
    apiClient.get<CustomerDetail>(`/customers/${id}`).then((response) => response.data),

  update: (id: string, data: UpdateCustomerRequest) =>
    apiClient.patch<Customer>(`/customers/${id}`, data).then((response) => response.data),

  tags: () =>
    apiClient.get<string[]>("/customers/tags").then((response) => response.data),

  segments: () =>
    apiClient.get<string[]>("/customers/segments").then((response) => response.data),

  stats: (params?: { channelId?: string }) =>
    apiClient.get<CustomerStatsResponse>("/customers/stats", { params }).then((response) => response.data),

  /** Link a chat contact to this customer; a chat linked to another customer is refused. */
  linkChat: (id: string, contactId: string) =>
    apiClient.post<{ contactId: string; customerId: string }>(`/customers/${id}/chats`, { contactId }).then((response) => response.data),

  unlinkChat: (id: string, contactId: string) =>
    apiClient.delete<{ contactId: string; customerId: null }>(`/customers/${id}/chats/${contactId}`).then((response) => response.data),
};
