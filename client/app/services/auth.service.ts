import { apiClient } from "~/lib/api-client";
import type {
  SignupRequest,
  SignupResponse,
  LoginRequest,
  LoginResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  ResendVerificationRequest,
  ResendVerificationResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  GetInviteResponse,
  AcceptInviteRequest,
  AcceptInviteResponse,
  SwitchOrgRequest,
  SwitchOrgResponse,
} from "~/types/api";

/**
 * Service layer for authentication API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const authService = {
  signup: (data: SignupRequest) =>
    apiClient.post<SignupResponse>("/auth/signup", data).then((response) => response.data),

  login: (data: LoginRequest) =>
    apiClient.post<LoginResponse>("/auth/login", data).then((response) => response.data),

  verifyEmail: (data: VerifyEmailRequest) =>
    apiClient
      .post<VerifyEmailResponse>("/auth/verify-email", data)
      .then((response) => response.data),

  resendVerification: (data: ResendVerificationRequest) =>
    apiClient
      .post<ResendVerificationResponse>("/auth/resend-verification", data)
      .then((response) => response.data),

  forgotPassword: (data: ForgotPasswordRequest) =>
    apiClient
      .post<ForgotPasswordResponse>("/auth/forgot-password", data)
      .then((response) => response.data),

  resetPassword: (data: ResetPasswordRequest) =>
    apiClient
      .post<ResetPasswordResponse>("/auth/reset-password", data)
      .then((response) => response.data),

  getInvite: (token: string) =>
    apiClient
      .get<GetInviteResponse>(`/auth/invite/${token}`)
      .then((response) => response.data),

  acceptInvite: (data: AcceptInviteRequest) =>
    apiClient
      .post<AcceptInviteResponse>("/auth/invite/accept", data)
      .then((response) => response.data),

  /** Revoke this session's refresh token on the server. */
  logout: (refreshToken: string) =>
    apiClient.post("/auth/logout", { refreshToken }).then((response) => response.data),

  /** Switch to a different organization — returns new JWT tokens scoped to the selected org. */
  switchOrg: (data: SwitchOrgRequest) =>
    apiClient
      .post<SwitchOrgResponse>("/auth/switch-org", data)
      .then((response) => response.data),
};
