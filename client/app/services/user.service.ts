import { apiClient } from "~/lib/api-client";
import type { ChangePasswordRequest, UpdateUserRequest } from "~/types/api";

/**
 * Service layer for user profile API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const userService = {
  getProfile: () =>
    apiClient.get("/users/me").then((response) => response.data),

  updateProfile: (data: UpdateUserRequest) =>
    apiClient.patch("/users/me", data).then((response) => response.data),

  changePassword: (data: ChangePasswordRequest) =>
    apiClient.post<{ message: string }>("/users/me/change-password", data).then((response) => response.data),

  deleteAccount: () =>
    apiClient.delete<{ message: string }>("/users/me").then((response) => response.data),

  /** Ends every other session of this account; this one stays signed in. */
  signOutOtherDevices: () =>
    apiClient.post<{ message: string }>("/users/me/sign-out-other-devices").then((response) => response.data),
};
