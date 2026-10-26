// ─── API Envelope Types ─────────────────────────────────────────────────────

/** Successful API response wrapper returned by the backend. */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/** Error API response wrapper returned by the backend. */
export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  errors?: string[];
  timestamp: string;
  path: string;
}

/** Discriminated union of success and error API responses. */
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// ─── Core Domain Types ──────────────────────────────────────────────────────

/** JWT token pair issued on login/refresh. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Authenticated user profile. */
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Collabo-team-only global admin flag. Controlled server-side via SUPER_ADMIN_EMAILS env. */
  isSuperAdmin?: boolean;
}

/** Metric used to decide a customer's loyalty tier. */
export type LoyaltyMetric = "ORDERS" | "TOTAL_SPENT";

/** Available pricing plan tiers. Mirrors the Prisma `BillingPlan` enum; ADVANCE is Enterprise. */
export type BillingPlan = "BASIC" | "GROWTH" | "ADVANCE";

/** The currencies plans are sold in. */
export type BillingCurrency = "INR" | "USD";

/** Billing cadence for a plan. Mirrors the Prisma `BillingInterval` enum. */
export type BillingInterval = "MONTHLY" | "YEARLY";

/** Razorpay subscription lifecycle. Mirrors the Prisma `SubscriptionStatus` enum. */
export type SubscriptionStatus =
  | "CREATED"
  | "AUTHENTICATED"
  | "ACTIVE"
  | "PAUSED"
  | "HALTED"
  | "CANCELLED"
  | "COMPLETED"
  | "EXPIRED";

// ─── Billing Request/Response Types ────────────────────────────────────────

/** Response from GET /billing/config — used to initialize Razorpay Checkout.js. */
export interface BillingConfigResponse {
  razorpayKeyId: string | null;
}

/** Payload for POST /billing/onboarding-checkout. */
export interface StartOnboardingCheckoutRequest {
  billingPlan: BillingPlan;
  billingInterval: BillingInterval;
  currency?: BillingCurrency;
}

/** A price in each currency's main unit (rupees, dollars). */
export type Money = Record<BillingCurrency, number>;

/** So many a month without charge, then a fee for each one over. `included: null` is unlimited. */
export interface PlanAllowance {
  included: number | null;
  fee: Money | null;
}

/** One plan from GET /billing/plans. */
export interface PricingPlan {
  id: BillingPlan;
  name: string;
  tagline: string;
  /** A month, before GST. Null: priced per contract (Enterprise). */
  price: Money | null;
  highlighted?: boolean;
  selfServe: boolean;
  conversations: PlanAllowance;
  members: PlanAllowance;
  callingMinutes: PlanAllowance;
  /** Each connected Instagram account, a month. Null: included. */
  instagram: Money | null;
}

/** Response from GET /billing/plans. */
export interface BillingPlansResponse {
  plans: PricingPlan[];
  gstPercent: number;
  /** The currencies each self-serve plan can be bought in right now. */
  checkout: Partial<Record<BillingPlan, BillingCurrency[]>>;
  salesEmail: string | null;
}

/** What an organization used in a month. */
export interface BillingUsage {
  conversations: number;
  callingMinutes: number;
  members: number;
  instagramAccounts: number;
}

export interface UsageChargeLine {
  key: "conversations" | "callingMinutes" | "members" | "instagram";
  quantity: number;
  /** In the main unit (rupees, dollars). */
  unitPrice: number;
  /** In the smallest unit (paise, cents). */
  amount: number;
}

/** Amounts in the smallest unit (paise, cents). */
export interface UsageCharges {
  lines: UsageChargeLine[];
  subtotal: number;
  tax: number;
  total: number;
}

export type UsageBillStatus = "PROCESSING" | "NOTHING_DUE" | "ADDED" | "LINK_SENT" | "PAID" | "SKIPPED" | "FAILED";

/** A month's usage over the plan, billed after the month ends. Amounts in the smallest unit. */
export interface UsageBill {
  id: string;
  period: string;
  status: UsageBillStatus;
  currency: BillingCurrency | null;
  usage: BillingUsage | null;
  lines: UsageChargeLine[] | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentUrl: string | null;
  note: string | null;
  updatedAt: string;
}

/** Response from GET /billing/usage (owners and admins). */
export interface BillingUsageSummary {
  /** This month, "2026-10" (UTC). */
  period: string;
  usage: BillingUsage;
  subscription: {
    plan: BillingPlan;
    status: SubscriptionStatus;
    currency: BillingCurrency;
    currentPeriodEnd: string | null;
  } | null;
  /** What this month would add on the plan, in the subscription's currency; null without a usage-priced subscription. */
  estimate: UsageCharges | null;
  bills: UsageBill[];
}

/** Response from POST /billing/onboarding-checkout. */
export interface StartOnboardingCheckoutResponse {
  subscriptionId: string;
  razorpayKeyId: string;
  currency: "INR" | "USD";
}

/** Response from GET /billing/pending-status — polled while waiting for the webhook. */
export interface PendingStatusResponse {
  status: SubscriptionStatus | null;
  plan: BillingPlan | null;
  interval: BillingInterval | null;
  subscriptionId: string | null;
}

/** Full organization entity used throughout the frontend. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  type: "PERSONAL" | "ORGANIZATION";
  logo: string | null;
  timezone: string;
  currency: string;
  industry: string | null;
  website: string | null;
  billingPlan: BillingPlan;
  billingInterval: BillingInterval | null;
  onboardingStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  // Loyalty fields: optional here because the auth-store membership can be
  // assembled client-side from a trimmed onboarding response. The full
  // `OrgResponse` from GET /organizations/{id} always has them.
  loyaltyMetric?: LoyaltyMetric;
  loyaltyBronzeMin?: number;
  loyaltySilverMin?: number;
  loyaltyGoldMin?: number;
  loyaltyPlatinumMin?: number;
  createdAt: string;
  updatedAt: string;
}

/** A user's membership in an organization, including the nested organization details. */
export interface OrganizationMembership {
  id: string;
  organizationId: string;
  role: UserRole;
  /** For VENDOR role: the Product.vendor value this membership is scoped to. */
  vendorScope?: string | null;
  /**
   * Fine-grained grants (`section.*`, `inventory.*`, `campaigns.*`) — see
   * lib/sections.ts. Absent when the session predates them, in which case the
   * role's defaults apply.
   */
  permissions?: string[];
  isActive: boolean;
  organization: Organization;
}

/** Possible roles a user can hold within an organization. */
export type UserRole =
  | "OWNER"
  | "ADMIN"
  | "MANAGER"
  | "AGENT"
  | "VIEWER"
  | "VENDOR"
  /**
   * External creator invited to collaborate. Like VENDOR, an outside party:
   * deny-by-default on the server, and confined here to the sections their
   * permissions name plus the channels they personally connected.
   */
  | "INFLUENCER";

// ─── Vendor-scoped order shapes (returned to VENDOR-role users) ──────────────

export interface VendorShipTo {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone?: string | null;
}

export interface VendorOrderLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** Units shipped so far, 0..quantity. */
  fulfilledQuantity: number;
  price: string | number;
  lineTotal: number;
  imageUrl: string | null;
  fulfillmentStatus: string | null;
  /** The live fulfilment this line belongs to (for per-product deliver/unfulfil). */
  fulfillmentId: string | null;
  /** Tracking from this line's fulfilment (shown inline once added). */
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
}

export interface VendorOrderFulfillment {
  id: string;
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  shippedAt: string | null;
  createdAt: string;
}

/** What `GET /orders/:id` returns to a VENDOR — their items only, no order-level money. */
export interface VendorOrderDetail {
  id: string;
  orderNumber: number;
  name: string;
  fulfillmentStatus: string;
  currency: string;
  createdAt: string;
  shipTo: VendorShipTo | null;
  billingAddress: VendorShipTo | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  lineItems: VendorOrderLine[];
  vendorSubtotal: number;
  fulfillments: VendorOrderFulfillment[];
}

// ─── Auth Request Types ────────────────────────────────────────────────────

/** Payload for user registration. */
export interface SignupRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  avatarUrl?: string;
}

/** Payload for user login (with optional TOTP for 2FA). */
export interface LoginRequest {
  email: string;
  password: string;
  totpCode?: string;
}

/** Payload for verifying a user's email via OTP code. */
export interface VerifyEmailRequest {
  userId: string;
  code: string;
}

/** Payload for re-sending the email verification code. */
export interface ResendVerificationRequest {
  userId: string;
}

// ─── Auth Response Types ───────────────────────────────────────────────────

/** Response returned after successful registration. */
export interface SignupResponse {
  userId: string;
  email: string;
  message: string;
  nextStep: "verify-email";
}

/** Simplified org shape returned by login/verify endpoints (flat, not nested). */
export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
  type: "PERSONAL" | "ORGANIZATION";
  role: UserRole;
  vendorScope?: string | null;
  permissions?: string[];
}

/** Response returned after successful login, including tokens and user info. */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
  };
  organizations: AuthOrganization[];
  nextStep: "choose-plan" | null;
}

/** Response returned after successful email verification. */
export interface VerifyEmailResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
  };
  organizations: AuthOrganization[];
  nextStep: "choose-plan" | null;
  message: string;
}

/** Response returned after re-sending the verification code. */
export interface ResendVerificationResponse {
  message: string;
  nextStep: "verify-email";
}

// ─── Forgot / Reset Password ──────────────────────────────────────────────

/** Payload for requesting a password reset email. */
export interface ForgotPasswordRequest {
  email: string;
}

/** Response after a password reset email is queued. */
export interface ForgotPasswordResponse {
  message: string;
}

/** Payload for setting a new password via a reset token. */
export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

/** Response after the password has been successfully reset. */
export interface ResetPasswordResponse {
  message: string;
}

// ─── Switch Org Types ────────────────────────────────────────────────────

/** Payload for switching to a different organization. */
export interface SwitchOrgRequest {
  orgId: string;
}

/** Response after switching organization — includes new JWT tokens scoped to the selected org. */
export interface SwitchOrgResponse {
  accessToken: string;
  refreshToken: string;
  currentOrganization: AuthOrganization;
  organizations: AuthOrganization[];
}

// ─── User Types ───────────────────────────────────────────────────────────

/** Payload for changing the current user's password (requires current password). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** Payload for updating user profile fields. */
export interface UpdateUserRequest {
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

// ─── Organization Types ──────────────────────────────────────────────────

/** The shape the backend returns for organization CRUD endpoints. */
export interface OrgResponse {
  id: string;
  name: string;
  slug: string;
  type: "PERSONAL" | "ORGANIZATION";
  logo: string | null;
  timezone: string;
  currency: string;
  industry: string | null;
  website: string | null;
  lowStockThreshold: number;
  gstEnabled: boolean;
  loyaltyMetric: LoyaltyMetric;
  loyaltyBronzeMin: number;
  loyaltySilverMin: number;
  loyaltyGoldMin: number;
  loyaltyPlatinumMin: number;
  billingPlan: BillingPlan;
  billingInterval: BillingInterval | null;
  onboardingStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  role: UserRole;
  createdAt: string;
}

/** Payload for creating a new team organization. */
export interface CreateOrganizationRequest {
  name: string;
  slug?: string;
  logo?: string;
  timezone?: string;
  currency?: string;
  industry?: string;
  website?: string;
  billingPlan: BillingPlan;
  billingInterval: BillingInterval;
}

/** Payload for creating a personal workspace. */
export interface CreatePersonalRequest {
  billingPlan: BillingPlan;
  billingInterval: BillingInterval;
}

/** Payload for updating an existing organization's settings. */
export interface UpdateOrganizationRequest {
  name?: string;
  logo?: string;
  timezone?: string;
  currency?: string;
  industry?: string;
  website?: string;
  lowStockThreshold?: number;
  gstEnabled?: boolean;
  // Loyalty thresholds: send all four together (monotonic ascending > 0).
  loyaltyMetric?: LoyaltyMetric;
  loyaltyBronzeMin?: number;
  loyaltySilverMin?: number;
  loyaltyGoldMin?: number;
  loyaltyPlatinumMin?: number;
}

/**
 * Payload for POST /organizations/:orgId/upgrade-to-organization.
 * Flips a PERSONAL workspace to ORGANIZATION in place. Fields mirror the
 * onboarding form (minus billing — the existing subscription stays put).
 */
export interface UpgradeToOrganizationRequest {
  name: string;
  logo?: string;
  industry?: string;
  website?: string;
  timezone?: string;
}

/** Response from POST /loyalty/recompute. */
export interface RecomputeLoyaltyResponse {
  updated: number;
  total: number;
}

// ─── Member Types ─────────────────────────────────────────────────────────

/** An organization member with their nested user profile. */
export interface OrgMember {
  id: string;
  role: UserRole;
  /** The member's full grant list; no `section.*` entry means full section access. */
  permissions?: string[];
  joinedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    lastLoginAt: string | null;
  };
}

/** Payload for changing a member's role. */
export interface UpdateMemberRoleRequest {
  role: UserRole;
  /** Required when role is VENDOR: the Product.vendor value to scope them to. */
  vendorScope?: string;
}

// ─── Team Invite Types ────────────────────────────────────────────────────

/** Payload for sending a team invitation. */
export interface SendInviteRequest {
  email: string;
  /** What to call the person before they have an account. */
  name?: string;
  role: UserRole;
  /** Required when role is VENDOR: the Product.vendor value to scope them to. */
  vendorScope?: string;
  /** For AGENT / VIEWER: the `section.*` grants the member starts with. */
  grants?: string[];
}

/** Payload for replacing a member's grant list (PATCH …/members/:id/permissions). */
export interface UpdateMemberPermissionsRequest {
  grants: string[];
}

/** Payload for inviting an influencer. The role is fixed by the endpoint. */
export interface InviteInfluencerRequest {
  email: string;
  name?: string;
}

/**
 * What an invitation is, as the merchant should see it.
 *
 * EXPIRED is derived server-side rather than stored: nothing writes it when the
 * date passes, so a lapsed invitation is still PENDING in the table.
 */
export type InviteState = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

/** A team invitation record. */
export interface OrgInvite {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  permissions?: string[];
  status: InviteState;
  token?: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

// ─── Influencers ──────────────────────────────────────────────────────────

/** An Instagram account an influencer has connected, as shown to an admin. */
export interface InfluencerChannel {
  id: string;
  platform: ChannelPlatform;
  name: string;
  status: ChannelStatus;
  externalStoreId: string | null;
  externalStoreUrl: string | null;
  connectedAt: string | null;
}

/**
 * One row of influencer management: either someone who joined, or an invitation
 * still in flight. The server returns both in one list because the UI shows
 * them in one table.
 */
export interface InfluencerRow {
  kind: "MEMBER" | "INVITE";
  memberId: string | null;
  inviteId: string | null;
  userId: string | null;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** ACTIVE once they have joined; otherwise the invitation's state. */
  status: InviteState | "ACTIVE";
  invitedAt: string;
  joinedAt: string | null;
  expiresAt?: string;
  /** Comes from the channel system, not a second copy kept for display. */
  channels: InfluencerChannel[];
}

// ─── Invite Types (Auth-level) ────────────────────────────────────────────

/** Response when fetching invite details by token (pre-accept). */
export interface GetInviteResponse {
  email: string;
  name: string | null;
  role: UserRole;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  };
  /**
   * True when the invited address already has an account. Acceptance then
   * requires signing in as that account — holding the link is not enough.
   */
  userExists: boolean;
  expiresAt: string;
}

/** Payload for accepting a team invitation (new or existing user). */
export interface AcceptInviteRequest {
  token: string;
  firstName?: string;
  lastName?: string;
  password?: string;
}

/** Response returned after successfully accepting an invitation (includes new session tokens). */
export interface AcceptInviteResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  /**
   * The role actually granted. Returned so the client stores the truth: it used
   * to assume AGENT, which left every later role check wrong until a reload.
   */
  role: UserRole;
  organization: {
    id: string;
    name: string;
    slug: string;
    type?: "PERSONAL" | "ORGANIZATION";
    role?: UserRole;
    vendorScope?: string | null;
    permissions?: string[];
  };
}

// ─── Pagination ──────────────────────────────────────────────────────────────

/** Paginated response envelope returned by list endpoints. */
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// ─── Channel Types ───────────────────────────────────────────────────────────

/** Supported sales channel platforms. */
export type ChannelPlatform =
  | "SHOPIFY"
  | "WOOCOMMERCE"
  | "INSTAGRAM"
  | "FACEBOOK"
  | "WHATSAPP"
  | "TIKTOK"
  | "MANUAL";

/** Raw connection status stored on the channel row. */
export type ChannelStatus = "CONNECTED" | "DISCONNECTED" | "ERROR" | "SYNCING";

/**
 * What the merchant is shown about a connection.
 *
 * Derived server-side, and deliberately not `ChannelStatus`: that enum is
 * overloaded (SYNCING is a Shopify data phase, and the sync path writes
 * ERROR/CONNECTED to it for reasons unrelated to whether the account is linked).
 */
export type ChannelConnectionState =
  | "CONNECTED"
  | "ERROR"
  | "EXPIRED"
  | "DISCONNECTED";

/** Current synchronization status. */
export type SyncStatus = "IDLE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

/**
 * The non-secret identity of a connected account.
 *
 * Built server-side by whitelisting display fields out of the encrypted
 * credentials blob — never the blob itself.
 */
export interface ChannelAccountSummary {
  /** Provider account id: Instagram business account id, WABA id, shop id. */
  externalId: string | null;
  /** The short label a merchant recognises: @handle, phone number, domain. */
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** One line of context: which Facebook Page, which WhatsApp Business Account. */
  detail: string | null;
}

/** One connected account on a channel (an Instagram handle, a WABA, a store). */
export interface Channel {
  id: string;
  name: string;
  platform: ChannelPlatform;
  status: ChannelStatus;
  isEnabled: boolean;
  connectionState: ChannelConnectionState;
  /** Null for platforms with nothing to show, and for a never-connected row. */
  account: ChannelAccountSummary | null;
  /** WhatsApp / Messenger / Instagram health. Null for other platforms. */
  messaging?: ChannelMessagingStatus | null;
  externalStoreId: string | null;
  externalStoreUrl: string | null;
  /** When this account was linked. Not `createdAt` — a revived row keeps that. */
  connectedAt: string | null;
  /** Why the connection is unhealthy, in words to show the merchant. */
  lastError: string | null;
  /** Null when the grant does not expire (Shopify offline, WhatsApp system user). */
  tokenExpiresAt: string | null;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
  syncStatus: SyncStatus;
  /**
   * Set by the outbound rate limiter when Shopify / Meta actually refused a
   * request and a cooldown is running. A past value is stale, not an error:
   * only treat it as active while it is in the future (see `rateLimit` on
   * ChannelDetail for the pre-computed flag).
   */
  rateLimitedUntil?: string | null;
  rateLimitReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Messaging health for a WhatsApp number, Facebook Page or Instagram account. */
export interface ChannelMessagingStatus {
  /** WhatsApp number also used on the WhatsApp Business app (coexistence). */
  isOnBizApp: boolean;
  quality: string | null;
  messagingLimit: string | null;
  throughput: string | null;
  nameStatus: string | null;
  coexistence: { state: string; sendsPaused: boolean } | null;
  historySync: {
    status: "pending" | "requested" | "importing" | "complete" | "declined" | "failed" | "expired" | (string & {});
    progress: number | null;
    messagesReceived: number | null;
    error: string | null;
  } | null;
  setup: { webhooks: string; registration: string } | null;
  webhooksOk: boolean | null;
  /** WhatsApp: whether Meta lets the number send, and what blocks it. */
  sending: WhatsAppSendingHealth | null;
}

/** Meta's health_status for a WhatsApp number: AVAILABLE, LIMITED or BLOCKED, with the reasons. */
export interface WhatsAppSendingHealth {
  state: "AVAILABLE" | "LIMITED" | "BLOCKED" | (string & {});
  problems: Array<{ description: string; solution: string | null }>;
}

/** Live outbound rate-limit summary for a channel (from GET /channels/:id). */
export interface ChannelRateLimit {
  limitedUntil: string | null;
  reason: string | null;
  active: boolean;
}

/** A single sync log entry recording a synchronization attempt. */
export interface SyncLog {
  id: string;
  channelId: string;
  status: SyncStatus;
  entityType: string;
  recordsProcessed: number;
  recordsFailed: number;
  totalEstimated: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Channel detail including recent sync history. */
export interface ChannelDetail extends Channel {
  syncLogs: SyncLog[];
  metadata: Record<string, unknown> | null;
  rateLimit?: ChannelRateLimit;
}

/** Payload for updating a channel's name or enabled status. */
export interface UpdateChannelRequest {
  name?: string;
  isEnabled?: boolean;
}

/** Payload for triggering a manual sync. */
export interface TriggerSyncRequest {
  entityTypes: string[];
}

/** One entity's toggle + sync state, for a single direction. */
export interface ChannelSyncEntityState {
  entityType: string;
  /** Absent server-side row means enabled — only an explicit false turns it off. */
  enabled: boolean;
  /** False until this entity has completed a first full/windowed backfill. */
  backfillDone: boolean;
  /** ISO timestamp this entity last synced cleanly, or null. */
  watermark: string | null;
}

/** Per-entity sync settings for a channel, both directions. */
export interface ChannelSyncSettings {
  channelId: string;
  platform: ChannelPlatform;
  pull: ChannelSyncEntityState[];
  push: ChannelSyncEntityState[];
  /**
   * How many local records a push would send RIGHT NOW. Shown next to the push
   * toggles because enabling one sends the whole backlog, and each pushed order
   * becomes a real Shopify order that cannot be un-created.
   */
  pendingPush: { orders: number; products: number };
}

/** Payload for saving per-entity sync settings. Full intent, not a delta. */
export interface UpdateSyncSettingsRequest {
  pull: string[];
  push: string[];
}

/** Payload for starting Shopify OAuth with merchant's custom app credentials. */
export interface ShopifyInstallRequest {
  // "my-store" | "my-store.myshopify.com" | full URL — server normalizes
  shopDomain: string;
  // Optional custom-app credentials (Partner Dashboard custom-distribution
  // apps) — when set, the OAuth flow runs with these instead of the
  // platform's public app.
  apiKey?: string;
  apiSecret?: string;
}

/** Payload for manually connecting a Shopify store with custom app credentials. */
export interface ManualConnectShopifyRequest {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
}

/** Response after manual Shopify connect. */
export interface ManualConnectShopifyResponse {
  channelId: string;
  shopName: string;
  shopDomain: string;
}

/**
 * What happens to one Shopify location's stock: it shares stock with an
 * existing Collabo location, became a new one, or is not tracked. Null until
 * the merchant decides — nothing syncs for that location before then.
 */
export type ShopifyLocationDecision =
  | { action: "link"; warehouseId: string; warehouseName: string }
  | { action: "create"; warehouseId: string; warehouseName: string }
  | { action: "ignore" };

export interface ShopifyLocation {
  id: string;
  name: string;
  isPrimary: boolean;
  isActive: boolean;
  address: { city: string; stateCode: string } | null;
  decision: ShopifyLocationDecision | null;
}

/** GET/POST /channels/:id/shopify/locations. PENDING while any location is undecided. */
export interface ShopifyLocationsResponse {
  status: "PENDING" | "DONE";
  locations: ShopifyLocation[];
  /** The workspace's own locations, as candidates to share stock with. */
  warehouses: Array<{
    id: string;
    name: string;
    kind: LocationKind;
    hasStock: boolean;
    shopifyLocationId: string | null;
  }>;
}

export type ShopifyLocationDecisionInput =
  | { shopifyLocationId: string; action: "link"; warehouseId: string; stockSource: LocationStockSource }
  | { shopifyLocationId: string; action: "create"; kind: LocationKind; name?: string }
  | { shopifyLocationId: string; action: "ignore" };

export interface SaveShopifyLocationsRequest {
  decisions: ShopifyLocationDecisionInput[];
}

/** Response containing the OAuth redirect URL. */
export interface OAuthInstallResponse {
  authUrl: string;
}

/**
 * Payload for POST /channels/instagram/install.
 *
 * `reconnectChannelId` means "re-authorize THIS account" rather than "add
 * another", which is what the Reconnect action on an errored or expired row
 * sends. Omitted for a plain connect.
 */
export interface InstagramInstallRequest {
  reconnectChannelId?: string;
}

/** One Instagram account a single Facebook login turned out to grant. */
export interface InstagramCandidate {
  igUserId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  pageId: string;
  pageName: string;
}

/** Response from GET /channels/instagram/pending/:id — the picker's options. */
export interface InstagramPendingResponse {
  pendingId: string;
  candidates: InstagramCandidate[];
}

/** Payload for POST /channels/instagram/complete — the merchant's choice. */
export interface CompleteInstagramRequest {
  pendingId: string;
  igUserId: string;
}

/** Response after the picked Instagram account is connected. */
export interface CompleteInstagramResponse {
  channelId: string;
  account: ChannelAccountSummary | null;
}

/** Payload for POST /channels/whatsapp/install. */
export interface WhatsAppInstallRequest {
  reconnectChannelId?: string;
}

/** Response from POST /channels/whatsapp/install — config for the Meta JS SDK. */
export interface WhatsAppInstallResponse {
  configId: string;
  state: string;
}

/** Payload for POST /channels/whatsapp/callback — the code returned by FB.login. */
export interface WhatsAppCallbackRequest {
  code: string;
  state: string;
  /** Session info Embedded Signup posted to the page on FINISH. */
  phoneNumberId?: string;
  wabaId?: string;
  isOnBizApp?: boolean;
  businessId?: string;
}

export interface WhatsAppSetupOutcome {
  webhooks: "ok" | "failed";
  webhooksError?: string;
  registration: "ok" | "failed" | "not_needed";
  registrationError?: string;
}

/** Response from POST /channels/whatsapp/callback after the channel is created. */
export interface WhatsAppCallbackResponse {
  channelId: string;
  redirectUrl: string;
  account: ChannelAccountSummary | null;
  /** The number also stays on the WhatsApp Business app (coexistence). */
  isOnBizApp: boolean;
  setup: WhatsAppSetupOutcome;
}

/** Response from POST /channels/:id/whatsapp/refresh-health. */
export interface WhatsAppNumberHealth {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  platform_type?: string;
  throughput?: { level?: string };
  name_status?: string;
  is_on_biz_app?: boolean;
  whatsapp_business_manager_messaging_limit?: string;
}

/** Facebook Login for Business: Pages (Messenger) and their Instagram accounts. */
export interface MessengerInstallResponse {
  configId: string;
  state: string;
}

export interface MessengerCallbackRequest {
  code: string;
  state: string;
}

export interface MessengerCallbackResponse {
  connected: Array<{
    channelId: string;
    platform: ChannelPlatform;
    account: ChannelAccountSummary | null;
    webhooks: "ok" | "failed";
  }>;
  skipped: Array<{ name: string; reason: string }>;
}

// ─── Product Types ───────────────────────────────────────────────────────────

/** Product publication status. */
export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

/** Derived stock status for filtering. */
export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

/** A product image with source URL, alt text, position, and optional dimensions. */
export interface ProductImage {
  id: string;
  src: string;
  alt: string | null;
  position: number;
  width?: number | null;
  height?: number | null;
}

/** A product variant with pricing, inventory, options, and optional image link. */
export interface ProductVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode?: string | null;
  price: number;
  compareAtPrice: number | null;
  cost?: number | string | null;
  inventoryQuantity: number;
  trackQuantity?: boolean;
  continueSellingWhenOutOfStock?: boolean;
  weight?: number | string | null;
  weightUnit?: "g" | "kg" | "oz" | "lb" | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
  requiresShipping?: boolean;
  taxable?: boolean;
  /** GST override for this variant only; null = inherit the product's value. */
  hsnCode?: string | null;
  gstRate?: number | string | null;
  unitOfMeasure?: string | null;
  supplyType?: GstSupplyType | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  position: number;
  imageId?: string | null;
}

/** Option-type definition (e.g. {name:"Size", values:["S","M","L"]}). */
export interface ProductOption {
  name: string;
  values: string[];
  position?: number;
}

/** Channel reference embedded in product/order/customer responses. */
export interface ChannelRef {
  id: string;
  name: string;
  platform: ChannelPlatform;
  /**
   * What this channel trades in. Catalogue prices are bare decimals with no
   * currency of their own, so this is what says whether a product price is
   * dollars or rupees. Null until a first order reveals it.
   */
  currency?: string | null;
}

/** Per-product Shopify sync status (sub-object of `Product.metadata.shopifySync`). */
export interface ProductShopifySync {
  status: "PENDING" | "SYNCED" | "FAILED" | "OUT_OF_SYNC";
  shopifyProductId?: string;
  error?: string;
  syncedAt?: string;
  /** When the PENDING claim was stamped; absent on rows claimed before it existed. */
  queuedAt?: string;
  attempts: number;
}

/** A product in a list response (summary view). */
export interface Product {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: ProductStatus;
  tags: string[];
  hsnCode?: string | null;
  gstRate?: number | string | null;
  totalStock: number;
  variantCount: number;
  priceRange: { min: number; max: number };
  /**
   * The currency `priceRange` and every `variants[].price` below are in.
   *
   * Normally the product's own channel currency. When the request asked for
   * `priceIn` it is that currency instead — unless the rate could not be
   * reached, in which case the prices are left alone and this still names the
   * channel's currency. Never assume the org's currency from it.
   */
  priceCurrency?: string | null;
  image: ProductImage | null;
  channel: ChannelRef;
  createdAt: string;
  updatedAt?: string;
  variants: ProductVariant[];
  /** Set when the product has been pushed (or attempted to be pushed) to Shopify. */
  shopifySync: ProductShopifySync | null;
}

/** GST nature of supply, per line item — mirrors the server's GstSupplyType enum. */
export type GstSupplyType =
  | "TAXABLE"
  | "EXEMPT"
  | "NIL_RATED"
  | "NON_GST"
  | "ZERO_RATED";

/** A product detail response with all variants, images, and CRM-managed fields. */
export interface ProductDetail extends Product {
  images: ProductImage[];
  bodyHtml?: string | null;
  hsnCode?: string | null;
  gstRate?: number | string | null;
  /** GST unit quantity code for GSTR-1 (NOS, KGS, PCS…). Not the variant weight unit. */
  unitOfMeasure?: string | null;
  supplyType?: GstSupplyType;
  options?: ProductOption[] | null;
  publishedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Result of any bulk operation: ids that succeeded vs ids skipped (with reason). */
export interface BulkResult {
  ok: string[];
  skipped: Array<{ id: string; reason: string }>;
  /** Set on bulkSync (count of jobs queued) and bulkDelete (rows hard-deleted). */
  queued?: number;
  deleted?: number;
}

/** CSV import job lifecycle (mirrors ProductImportJob model server-side). */
export type ProductImportStatus =
  | "PARSING"
  | "PREVIEW"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED";

export interface ProductImportError {
  row: number;
  handle?: string;
  message: string;
}

export interface ProductImportJob {
  id: string;
  status: ProductImportStatus;
  filename: string;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  errors: ProductImportError[];
  previewRows: Record<string, string>[];
  createdAt: string;
  completedAt: string | null;
}

/** Variant block on a create-product / update-product request. */
/** A new variant's starting quantity at one location. */
export interface OpeningStockLine {
  warehouseId: string;
  quantity: number;
}

export interface ProductVariantInput {
  /** Existing variant id when editing — `undefined` for a freshly-added row. */
  id?: string;
  price: number;
  sku?: string;
  barcode?: string;
  compareAtPrice?: number;
  cost?: number;
  inventoryQuantity?: number;
  /**
   * Opening stock per location, for workspaces with stock locations (create
   * only). The server ignores `inventoryQuantity` when this is sent.
   */
  stock?: OpeningStockLine[];
  trackQuantity?: boolean;
  continueSellingWhenOutOfStock?: boolean;
  weight?: number;
  weightUnit?: "g" | "kg" | "oz" | "lb";
  hsCode?: string;
  countryOfOrigin?: string;
  requiresShipping?: boolean;
  taxable?: boolean;
  /** GST override for this variant only; omit to inherit the product's value. */
  hsnCode?: string;
  gstRate?: number;
  unitOfMeasure?: string;
  supplyType?: GstSupplyType;
  option1?: string;
  option2?: string;
  option3?: string;
  position?: number;
  imageId?: string;
}

/**
 * Payload for creating a CRM-native product. Either `variant` (single, legacy)
 * OR `variants` + `options` (multi-variant) — mutually exclusive.
 */
export interface CreateProductRequest {
  title: string;
  vendor?: string;
  productType?: string;
  status?: ProductStatus;
  tags?: string[];
  bodyHtml?: string;
  hsnCode?: string;
  /** `null` clears the rate on update. */
  gstRate?: number | null;
  unitOfMeasure?: string;
  supplyType?: GstSupplyType;
  /** ISO 8601 string. When set on a DRAFT product in the future, the
   *  scheduler will flip it to ACTIVE on/after this date. `null` clears it. */
  publishedAt?: string | null;
  variant?: ProductVariantInput;
  variants?: ProductVariantInput[];
  options?: ProductOption[];
}

/** Payload for editing a MANUAL-channel product. All fields optional. */
export type UpdateProductRequest = Partial<
  Omit<CreateProductRequest, "variant" | "gstRate">
> & {
  variant?: Partial<ProductVariantInput>;
  /** null clears the rate back to "Not set". */
  gstRate?: number | null;
};

/** Variant CRUD payloads (for /products/:id/variants and /variants/:id endpoints). */
export interface CreateVariantRequest {
  price: number;
  sku?: string;
  barcode?: string;
  compareAtPrice?: number;
  cost?: number;
  inventoryQuantity?: number;
  trackQuantity?: boolean;
  continueSellingWhenOutOfStock?: boolean;
  weight?: number;
  weightUnit?: "g" | "kg" | "oz" | "lb";
  hsCode?: string;
  countryOfOrigin?: string;
  requiresShipping?: boolean;
  taxable?: boolean;
  /** GST override for this variant only; omit to inherit the product's value. */
  hsnCode?: string;
  gstRate?: number;
  unitOfMeasure?: string;
  supplyType?: GstSupplyType;
  option1?: string;
  option2?: string;
  option3?: string;
  position?: number;
  imageId?: string;
}

export type UpdateVariantRequest = Omit<
  Partial<CreateVariantRequest>,
  | "imageId"
  | "sku"
  | "barcode"
  | "cost"
  | "compareAtPrice"
  | "weight"
  | "hsCode"
  | "countryOfOrigin"
  | "hsnCode"
  | "gstRate"
  | "unitOfMeasure"
  | "supplyType"
> & {
  /** `null` clears the stored value; omit the field to leave it unchanged. */
  sku?: string | null;
  barcode?: string | null;
  cost?: number | null;
  compareAtPrice?: number | null;
  weight?: number | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
  /** GST override; `null` = back to inheriting from the product. */
  hsnCode?: string | null;
  gstRate?: number | null;
  unitOfMeasure?: string | null;
  supplyType?: GstSupplyType | null;
};

/** Query parameters for the product list endpoint. */
export interface ProductListParams {
  page?: number;
  limit?: number;
  status?: ProductStatus;
  vendor?: string;
  productType?: string;
  channelId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  stockStatus?: StockStatus;
  /**
   * Restate every variant price in this ISO currency (e.g. "INR").
   *
   * Catalogue prices are normally read in their own channel's currency, which
   * is what the product screens show. The counter-sale builder asks for one
   * currency instead, because it prices a single order in the org's currency
   * and must display the number it will actually charge.
   */
  priceIn?: string;
}

// ─── Order Types ─────────────────────────────────────────────────────────────

/** Financial status of an order. */
export type FinancialStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOIDED";

/** Fulfillment status of an order. */
export type FulfillmentStatus = "UNFULFILLED" | "FULFILLED" | "PARTIAL" | "RESTOCKED";

/** Customer summary embedded in an order response. */
export interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Selected by the detail endpoint only — absent on list responses. */
  phone?: string | null;
  /** Selected by the detail endpoint only. Same untyped shape as `Order.shippingAddress`. */
  defaultAddress?: Record<string, unknown> | null;
}

/**
 * Push-sync state for a MANUAL order we created in Shopify. Mirrors
 * `ShopifySyncMetadata` in server/src/channel/shopify-push.service.ts.
 *
 * Natively-Shopify orders never carry this blob — their external identity is
 * the `externalId` column instead.
 */
export interface OrderShopifySync {
  status: "PENDING" | "SYNCED" | "FAILED";
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  error?: string;
  syncedAt?: string;
  /** When the PENDING claim was stamped; absent on rows claimed before it existed. */
  queuedAt?: string;
  attempts?: number;
}

/** An order in a list response (summary view). */
export interface Order {
  id: string;
  orderNumber: number;
  name: string;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  currency: string;
  totalPrice: number;
  subtotalPrice: number;
  totalTax: number;
  totalDiscounts: number;
  totalShippingPrice: number;
  tags: string[];
  note: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  /** Present on detail responses; absent on list responses. */
  closedAt?: string | null;
  /**
   * @deprecated Always `undefined`. The `orders` table has no email/phone
   * columns, and the detail handler spreads the raw row, so neither of these is
   * ever populated on either endpoint. Read `customer.email` / `customer.phone`.
   */
  email?: string | null;
  /** @deprecated Always `undefined` — see `email`. Read `customer.phone`. */
  phone?: string | null;
  /** Present on detail responses; absent on list responses. */
  shippingAddress?: Record<string, unknown> | null;
  /** Present on detail responses; absent on list responses. */
  billingAddress?: Record<string, unknown> | null;
  customer: OrderCustomer | null;
  channel: ChannelRef;
  /** Shopify's raw source code (`web`, `pos`, `collabo-crm`, …). Null until a sync stores it. */
  sourceName?: string | null;
  /** Shopify's display name for the app that created the order. Null on webhook-only orders. */
  sourceLabel?: string | null;
  /**
   * Computed via `_count` on the LIST endpoint only — `undefined` on detail
   * responses despite the non-optional type. Fall back to `lineItems.length`.
   */
  itemCount: number;
  /**
   * The push record, on the LIST endpoint only (the detail endpoint carries
   * the whole `metadata` blob instead). Null when the order was never pushed.
   * Read it through `orderShopifySyncOf`, which handles both shapes.
   */
  shopifySync?: OrderShopifySync | null;
  /**
   * Row insert time. On the DETAIL endpoint this is the local DB timestamp, not
   * when the order was placed — the list and vendor endpoints map
   * `externalCreatedAt ?? createdAt` but `findOne` does not. Prefer
   * `externalCreatedAt ?? createdAt` when rendering a detail page.
   */
  createdAt: string;
  /** When the order was placed on the source channel. Null for CRM-native orders. */
  externalCreatedAt?: string | null;
  /**
   * The source channel's own order id. For CRM-native orders this is NOT a
   * channel id — the server writes a synthetic `manual_<uuid>`, so gate any
   * display of it on the prefix or on `channel.platform`.
   */
  externalId?: string | null;
  /** GST place-of-supply state code. Only set when a seller GSTIN resolved at order time. */
  placeOfSupplyCode?: string | null;
  /** Free-form metadata, includes `source`, `paymentMethod`, `shopifySync`, etc. */
  metadata?: Record<string, unknown> | null;
}

/** A line item within an order detail. */
export interface OrderLineItem {
  id: string;
  title: string;
  quantity: number;
  /**
   * Units shipped so far, 0..quantity. Authoritative for partial shipments —
   * `fulfillmentStatus` alone cannot express "2 of 5 sent".
   */
  fulfilledQuantity: number;
  price: number;
  sku: string | null;
  variantTitle: string | null;
  /** Per-line fulfilment state: null | 'fulfilled' | 'delivered' | 'on_hold' | 'in_progress'. */
  fulfillmentStatus: string | null;
  /** Flattened product/variant thumbnail (variant image, else first product image). */
  imageUrl: string | null;
  /** Tracking from this line's fulfilment (shown inline once added). */
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  /**
   * Line-level discount. Serialized as a STRING (Prisma Decimal) — wrap in
   * `Number()` before doing arithmetic with it.
   */
  totalDiscount?: number | string | null;
  /**
   * The live variant this line points at. Included by the detail endpoint only,
   * and null when the variant has since been deleted.
   *
   * Line items never snapshot weight, so shipping weight has to be read from
   * here — see the `variant` select in `OrderService.findOne`.
   */
  variant?: {
    id: string;
    title: string | null;
    sku: string | null;
    /** Prisma Decimal — serialized as a string. */
    price: number | string;
    /** Prisma Decimal — serialized as a string. */
    weight?: number | string | null;
    /** Free-form: "kg" | "g" | "lb" | "oz". Nullable, and can differ per line. */
    weightUnit?: string | null;
  } | null;
}

/**
 * A fulfillment record within an order detail.
 *
 * The server includes this relation with no `select`, so the whole row is on
 * the wire; the optional fields below are declared to make that usable.
 */
export interface OrderFulfillment {
  id: string;
  /**
   * Free-form. The only values ever written are `pending`, `fulfilled`,
   * `delivered`, `cancelled` (plus whatever Shopify's own status carries).
   * There is no packed / picked-up / in-transit state.
   */
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  createdAt: string;
  trackingCompany?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  /** The source channel's fulfilment id. */
  externalId?: string | null;
  /**
   * Carries `lineItemIds: string[]` for CRM-created fulfilments. Shopify sync
   * never writes it, so do NOT rely on this to work out shipment membership —
   * derive from `lineItems[].fulfillmentStatus` instead.
   */
  metadata?: Record<string, unknown> | null;
}

/** A refund record within an order detail. */
export interface OrderRefund {
  id: string;
  amount: number;
  reason: string | null;
  createdAt: string;
}

/**
 * A timeline event within an order detail.
 *
 * Written only by CRM-initiated actions — Shopify sync produces no timeline
 * rows, so an order fulfilled or captured in Shopify admin never appears here.
 */
export interface OrderTimeline {
  id: string;
  message: string;
  createdAt: string;
  /**
   * The complete set written by any code path.
   *
   * From `OrderService` (a real user acted; `actorId` is set):
   * `created` | `updated` | `cancelled` | `closed` | `reopened` | `paid` |
   * `captured` | `fulfilled` | `tracking_updated` | `fulfillment_cancelled` |
   * `delivered` | `items_status_changed` | `item_delivered` |
   * `item_unfulfilled` | `sync_queued`.
   *
   * From `ShopifySyncService` (changed in Shopify Admin; `actorId` is null and
   * `metadata.source === "shopify"`):
   * `created` | `paid` | `payment_status_changed` | `fulfilled` |
   * `fulfillment_status_changed` | `cancelled` | `closed` | `reopened` |
   * `refunded`.
   *
   * Typed as a free string, not a union, because the column is a bare `String`
   * with no server-side enum.
   */
  action?: string | null;
  /**
   * The acting user's id. **Never null in practice** — every write site passes a
   * real user id, so there are no system-authored events and this cannot be used
   * to tell system from user activity.
   *
   * `OrderTimelineEvent.actorId` has no Prisma relation to `User`, so the server
   * cannot resolve it to a name; a display name needs a client-side join against
   * the org member list on `member.user.id`.
   */
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Full order detail with line items, fulfillments, refunds, and timeline. */
export interface OrderDetail extends Order {
  lineItems: OrderLineItem[];
  fulfillments: OrderFulfillment[];
  refunds: OrderRefund[];
  timeline: OrderTimeline[];
  /**
   * Why automatic invoicing did not issue a document for this order, if it
   * tried and failed. Cleared as soon as an invoice is issued, and never set
   * when the order already has one. The server has always returned it; it was
   * simply never shown, so a failure was invisible on the order itself.
   */
  invoiceError?: string | null;
  invoiceErrorAt?: string | null;
  /** Warehouse the goods left from, when one was recorded. */
  dispatchWarehouseId?: string | null;
  dispatchWarehouse?: { id: string; name: string; code: string } | null;
  /** The order's live (non-cancelled) GST invoice — at most one, enforced by
   *  a partial unique index server-side. Empty array when not invoiced. */
  invoices?: Pick<
    Invoice,
    "id" | "invoiceNumber" | "invoiceDate" | "status" | "grandTotal"
  >[];
}

/**
 * One order's worth of package-slip content, from GET /orders/slips/data.
 *
 * Deliberately the subset of `OrderDetail` that a slip renders, so
 * `<PackageSlip>` takes this type and the per-order route can hand it a full
 * `OrderDetail` unchanged — `OrderDetail` structurally satisfies it. Keep the
 * two in step: widening this without widening the server's `select` gives the
 * batch route `undefined` where the per-order route has a value.
 *
 * Both date fields are present because the slip prints `externalCreatedAt`
 * when there is one (the date the order was placed on the channel) and falls
 * back to `createdAt`.
 */
export interface OrderSlipData {
  id: string;
  /** Display order number, hash included — "#1201". */
  name: string;
  createdAt: string;
  externalCreatedAt?: string | null;
  note?: string | null;
  shippingAddress?: Record<string, unknown> | null;
  customer?: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  lineItems: Array<{
    id: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
  }>;
}

/** Query parameters for the order list endpoint. */
/** Neighbours of one order in the newest-first list, for the detail page rail. */
export interface AdjacentOrders {
  /** The order before this one (newer). Null at the start of the list. */
  previousId: string | null;
  /** The order after this one (older). Null at the end of the list. */
  nextId: string | null;
  /** 1-based position across ALL orders, not a fetched window. */
  position: number;
  total: number;
}

export interface OrderListParams {
  page?: number;
  limit?: number;
  financialStatus?: FinancialStatus;
  fulfillmentStatus?: FulfillmentStatus;
  channelId?: string;
  productId?: string;
  customerId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  dateFrom?: string;
  dateTo?: string;
}

/** Payment method for offline / in-store sales. */
export type OfflinePaymentMethod = "CASH" | "CARD" | "UPI" | "OTHER";

/** Customer block on a create-offline-order request. */
export interface OfflineCustomerInput {
  customerId?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  gstin?: string;
  billingStateCode?: string;
  address?: Record<string, unknown>;
}

/** A line item on a create-offline-order request. */
export interface OfflineLineItemInput {
  productVariantId: string;
  quantity: number;
  unitPriceOverride?: number;
  discount?: number;
}

/**
 * Address bag stored on an order.
 *
 * Shopify-compatible snake_case keys so synced and offline orders share one
 * shape, plus `stateCode` — the 2-digit GST state code, which is what drives
 * place-of-supply resolution (and therefore CGST+SGST vs IGST). Send both
 * `province` (the display name) and `stateCode`: slips and invoices render the
 * former, the tax resolver reads the latter.
 */
export interface OrderAddressInput {
  first_name?: string;
  last_name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  stateCode?: string;
  zip?: string;
  country?: string;
  country_code?: string;
  phone?: string;
}

/** Payload for creating an offline (in-store) order. */
export interface CreateOfflineOrderRequest {
  customer: OfflineCustomerInput;
  lineItems: OfflineLineItemInput[];
  sellerGstinId?: string;
  /** Warehouse the goods leave from; omitted lets the invoice fall back. */
  warehouseId?: string;
  placeOfSupplyCode?: string;
  paymentMethod: OfflinePaymentMethod;
  note?: string;
  financialStatus?: FinancialStatus;
  fulfillmentStatus?: FulfillmentStatus;
  generateInvoice?: boolean;
  /** Omit for a counter sale. When present, the state sets GST place of supply. */
  shippingAddress?: OrderAddressInput;
  billingAddress?: OrderAddressInput;
}

/** Server response from POST /orders/offline. */
export interface CreateOfflineOrderResponse {
  order: OrderDetail;
  invoice: InvoiceDetail | null;
  invoiceError: string | null;
}

// ─── Phase 1: Order Lifecycle & Metadata ────────────────────────────────────

/** Reasons accepted by POST /orders/:id/cancel. Mirrors the Prisma enum. */
export type OrderCancelReason =
  | "CUSTOMER"
  | "FRAUD"
  | "INVENTORY"
  | "DECLINED"
  | "OTHER";

/** Payload for PATCH /orders/:id. Every field is optional; only sent fields update. */
/**
 * `email`, `phone`, `poNumber` and `customAttributes` were removed: the server
 * accepted them but stored none of them (no columns exist), so sending them was
 * a silent no-op. The API now rejects them outright.
 *
 * `billingAddress` is accepted for MANUAL orders only — Shopify's order-update
 * API has no billing address field, so on a Shopify order the server refuses it
 * rather than let the next sync silently revert the change.
 */
export interface UpdateOrderRequest {
  tags?: string[];
  note?: string;
  shippingAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
}

/** Payload for POST /orders/:id/cancel. */
export interface CancelOrderRequest {
  reason: OrderCancelReason;
  refund?: boolean;
  restock?: boolean;
  notifyCustomer?: boolean;
  staffNote?: string;
}

/** Payload for POST /orders/:id/capture. Shopify-only; amount defaults to full balance. */
export interface CapturePaymentRequest {
  amount?: number;
  currency?: string;
  finalCapture?: boolean;
}

// ─── Phase 2: Fulfillment & Tracking ────────────────────────────────────────

/** Tracking info sent on create / update — number, URL, carrier. All optional. */
export interface TrackingInfoInput {
  number?: string;
  url?: string;
  company?: string;
}

/** One line item in a create-fulfillment request. */
export interface FulfillmentLineItemInput {
  /** OrderLineItem ID — numeric Shopify ID for SHOPIFY orders, local cuid for MANUAL. */
  lineItemId: string;
  /** Defaults to the full remaining quantity when omitted. */
  quantity?: number;
}

/** Payload for POST /orders/:id/fulfillments. */
export interface CreateFulfillmentRequest {
  lineItems: FulfillmentLineItemInput[];
  tracking?: TrackingInfoInput;
  /** SHOPIFY only — sends shipping confirmation email when true. */
  notifyCustomer?: boolean;
}

/** Payload for PATCH /orders/:id/fulfillments/:fid/tracking. */
export interface UpdateTrackingRequest {
  tracking: TrackingInfoInput;
  notifyCustomer?: boolean;
}

/** One line item on a fulfillment order, returned by the fulfillable query. */
export interface FulfillableLineItem {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  remainingQuantity: number;
  totalQuantity: number;
}

/** One fulfillment-order bucket of line items still eligible for fulfillment. */
export interface FulfillableFulfillmentOrder {
  id: string;
  status: string;
  locationName: string | null;
  lineItems: FulfillableLineItem[];
}

/** Response from GET /orders/:id/fulfillable-line-items. */
export interface FulfillableLineItemsResponse {
  source: "shopify" | "manual";
  fulfillmentOrders: FulfillableFulfillmentOrder[];
}

// ─── Organization Settings ──────────────────────────────────────────────────

/** Product-domain settings stored as JSONB on OrganizationSettings.productSettings. */
export interface ProductSettings {
  /** When true, products created in the CRM are auto-pushed to Shopify. Default false. */
  autoSyncToShopify: boolean;
  /**
   * Global override for the per-variant continue-selling-when-out-of-stock flag.
   * When true, all variants behave as continue-selling regardless of their
   * individual setting. Default false.
   */
  allowOversellGlobally: boolean;
  /**
   * Global override for the per-variant track-quantity flag. When true, every
   * variant tracks inventory regardless of its individual setting — stock
   * decrements on offline orders, Shopify pushes set inventory_management to
   * `shopify`. Default false (per-variant flag is honored as-is).
   */
  trackQuantityGlobally: boolean;
  /**
   * Multi-vendor routing: when true, product sync reads the vendor from the
   * Shopify product metafield `{vendorMetafieldNamespace}.{vendorMetafieldKey}`
   * into Product.vendorKey (the primary vendor match key; built-in Product.vendor
   * is the fallback). Default false.
   */
  vendorMetafieldEnabled: boolean;
  vendorMetafieldNamespace: string;
  vendorMetafieldKey: string;
}

/** Order-domain settings stored as JSONB on OrganizationSettings.orderSettings. */
export interface OrderSettings {
  /** When true, offline orders created in the CRM are auto-pushed to Shopify. Default false. */
  autoSyncToShopify: boolean;
  /**
   * When true, a GST invoice is issued automatically for a Shopify order the
   * moment it becomes PAID. Default false.
   *
   * Shopify orders only, and live webhooks only — a bulk backfill never
   * auto-invoices, or a first connect would issue invoices for up to 60 days
   * of history all dated today. Offline orders are unaffected: they already
   * invoice inline at creation and are written PAID.
   *
   * Requires GST enabled with a registered GSTIN; without them the attempt
   * soft-fails server-side and the order still syncs.
   */
  autoInvoiceOnPayment: boolean;
  /**
   * When true, a cash-on-delivery order is invoiced when it ships rather than
   * when it is paid, since GST wants the invoice by dispatch. Shopify
   * fulfilments and shipments made in the CRM. Default false.
   */
  autoInvoiceCodOnShipping: boolean;
}

/** Per-org GST/tax settings. Both values change STATUTORY OUTPUT. */
export interface TaxSettings {
  /**
   * Invoice value at or below which an inter-State B2C supply is summarised in
   * GSTR-1 table 7 rather than reported invoice-wise in table 5.
   *
   * A setting, not a constant: the statutory figure dropped from Rs 2,50,000 to
   * Rs 1,00,000 in November 2024, and an accountant may still be filing a prior
   * period against the older limit.
   */
  b2cLargeThreshold: number;
  /**
   * Unit quantity code used for GSTR-1 table 12 rows when a product does not
   * specify one. Table 12 requires a unit on every row.
   */
  defaultUnitOfMeasure: string;
  /**
   * Tax delivery as a composite supply, at the principal supply's rate.
   *
   * ⚠️ DEFAULT OFF — the only setting here that changes tax charged on a real
   * transaction. For a Shopify order the customer was already charged at
   * checkout, so enabling this before the store's own shipping-tax setting
   * matches makes the invoice declare more than was collected.
   */
  taxShipping: boolean;
  /**
   * Series prefix for invoice numbers — "SJ" gives SJ-26-27/000001. Defaults
   * to "INV". Up to 3 letters or digits; "CN" is reserved for credit notes.
   *
   * ⚠️ Changing it starts a new consecutive run at 000001, because the next
   * number is read back per prefix.
   */
  invoicePrefix: string;
  /**
   * "Catalogue prices include GST": GST is taken out of a product's price, or
   * one typed into an order, instead of added on top. Null until the merchant
   * chooses; until then the store's Shopify orders decide (see
   * `OrganizationSettingsResponse.pricesIncludeTax`).
   */
  pricesIncludeTax: boolean | null;
}

/**
 * The merchant's own business identity — the "From" block and contact row on a
 * package slip.
 *
 * Lives here rather than on `OrgResponse` because `Organization` has no
 * address, phone or email columns at all; this is a settings domain
 * (`store_profile_settings` JSONB). Every field defaults to `""` server-side,
 * and blank means "fall back" — to `Organization.name` / `.website`, or for
 * the address, to the order's dispatch warehouse and then the default GSTIN.
 *
 * Address keys are the app's canonical set, so `readAddress()` reads this
 * directly.
 */
export interface StoreProfileSettings {
  storeName: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  country: string;
  supportPhone: string;
  /** Often different from `supportPhone`; the slip prints both. */
  whatsappPhone: string;
  supportEmail: string;
  website: string;
  /** Absolute URL — there is no upload pipeline for this yet. */
  logoUrl: string;
}

/** Response from GET /organization/settings — every domain returned together. */
export interface OrganizationSettingsResponse {
  productSettings: ProductSettings;
  orderSettings: OrderSettings;
  inventorySettings: InventorySettings;
  taxSettings: TaxSettings;
  storeProfileSettings: StoreProfileSettings;
  /**
   * How orders and drafts read a catalogue or typed price. `effective` is
   * `taxSettings.pricesIncludeTax` once chosen, else `detected` (what the
   * store's own Shopify orders say, null with none), else false.
   */
  pricesIncludeTax: { effective: boolean; detected: boolean | null };
}

/** Patch payload for PATCH /organization/settings/store-profile. */
export type UpdateStoreProfileSettingsRequest = Partial<StoreProfileSettings>;

/** Patch payload for PATCH /organization/settings/products. */
export type UpdateProductSettingsRequest = Partial<ProductSettings>;

/** Patch payload for PATCH /organization/settings/orders. */
export type UpdateOrderSettingsRequest = Partial<OrderSettings>;

/** Patch payload for PATCH /organization/settings/tax. */
export type UpdateTaxSettingsRequest = Partial<TaxSettings>;

// ─── Manual sync endpoints ──────────────────────────────────────────────────

/** Response from POST /products/:id/sync or POST /orders/:id/sync. */
export interface ManualSyncResponse {
  /** ALREADY_SYNCED: no-op, was already on Shopify. ALREADY_QUEUED: a push job
   * is already in-flight. QUEUED: a new push job was enqueued just now. */
  status: "ALREADY_SYNCED" | "ALREADY_QUEUED" | "QUEUED";
  productId?: string;
  orderId?: string;
}

// ─── Draft Orders ───────────────────────────────────────────────────────────

export type DraftOrderStatus = "OPEN" | "INVOICE_SENT" | "COMPLETED";

/** Customer block on a create / update draft request. */
export interface DraftCustomerInput {
  customerId?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  gstin?: string;
  billingStateCode?: string;
  address?: Record<string, unknown>;
}

/** Line item on a create / update draft request. */
export interface DraftLineItemInput {
  productVariantId: string;
  quantity: number;
  unitPriceOverride?: number;
  discount?: number;
}

/** Payload for POST /draft-orders. Customer block is optional (anonymous drafts allowed). */
export interface CreateDraftOrderRequest {
  customer?: DraftCustomerInput;
  lineItems: DraftLineItemInput[];
  note?: string;
  tags?: string[];
  shippingAddress?: OrderAddressInput;
  billingAddress?: OrderAddressInput;
  placeOfSupplyCode?: string;
}

/** Payload for PATCH /draft-orders/:id. */
export type UpdateDraftOrderRequest = Partial<CreateDraftOrderRequest>;

/** Payload for POST /draft-orders/:id/complete. */
export interface CompleteDraftRequest {
  paymentMethod?: OfflinePaymentMethod;
  paymentPending?: boolean;
  generateInvoice?: boolean;
  sellerGstinId?: string;
}

/** Payload for POST /draft-orders/:id/send-invoice. */
export interface SendDraftInvoiceRequest {
  to?: string;
  subject?: string;
  customMessage?: string;
  bcc?: string[];
}

/** Customer summary embedded in a draft order list/detail response. */
export interface DraftOrderCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

/** Draft list row. */
export interface DraftOrder {
  id: string;
  name: string | null;
  status: DraftOrderStatus;
  currency: string;
  totalPrice: number;
  subtotalPrice: number;
  totalTax: number;
  totalDiscounts: number;
  totalShippingPrice: number;
  customerEmail: string | null;
  note: string | null;
  tags: string[];
  invoiceUrl: string | null;
  invoiceSentAt: string | null;
  completedAt: string | null;
  completedOrder: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  customer: DraftOrderCustomer | null;
  channel: ChannelRef;
  itemCount: number;
}

/** Line item on a draft order detail response. */
export interface DraftOrderLineItem {
  id: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: number;
  totalDiscount: number;
  taxable: boolean;
  requiresShipping: boolean;
  variant: { id: string; title: string; sku: string | null; price: number } | null;
}

/** Full draft detail. */
export interface DraftOrderDetail extends DraftOrder {
  lineItems: DraftOrderLineItem[];
  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
}

/** Query parameters for the draft list endpoint. */
export interface DraftOrderListParams {
  page?: number;
  limit?: number;
  status?: DraftOrderStatus;
  customerId?: string;
  channelId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/**
 * Aggregates for the drafts KPI row and the filter-chip counts.
 *
 * Org-wide, not page-derived — the list pages at 15 rows, so summing the
 * response would have made every figure change when the user pressed Next.
 */
export interface DraftOrderStats {
  /** `value` is the whole pipeline still in play: OPEN + INVOICE_SENT. */
  openDrafts: { count: number; value: number };
  invoiceSent: { count: number };
  /**
   * `changePct` is null when last month had none — `StatCard` omits the badge
   * on `undefined`, and passing 0 renders a green "0%" up-trend instead.
   */
  convertedThisMonth: {
    count: number;
    value: number;
    changePct: number | null;
    valueChangePct: number | null;
  };
  /** ISO bounds of the month-to-date window, for the card sub-labels. */
  periodStart: string;
  periodEnd: string;
  counts: { all: number; open: number; invoiceSent: number; completed: number };
  currency: string;
}

/** Response from POST /draft-orders/:id/complete. */
export interface CompleteDraftResponse {
  draftId: string;
  /**
   * Null when the draft was completed in Shopify and the order hasn't synced
   * into the CRM yet — the server waits a few seconds for it, not forever.
   */
  order: OrderDetail | null;
  /** Shopify's order name ("#1015") when completed via Shopify. */
  shopifyOrderName?: string | null;
  invoice: InvoiceDetail | null;
  invoiceError: string | null;
}

// ─── Customer Types ──────────────────────────────────────────────────────────

/** VIP tier for a customer. */
export type VipLevel = "NONE" | "BRONZE" | "SILVER" | "GOLD" | "PLATINUM";

/** A customer in a list response (summary view). */
export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  vipLevel: VipLevel;
  totalSpent: number;
  ordersCount: number;
  tags: string[];
  segments: string[];
  state: string | null;
  channel: ChannelRef;
  /**
   * GST columns. Present on every customer row, but the server's `findAll`
   * projection used to drop them, so the list's GSTIN column always read
   * "Not set" — masked by an `as any` cast at the call site.
   */
  gstin: string | null;
  billingStateCode: string | null;
  billingStateName: string | null;
  createdAt: string;
}

/**
 * A customer activity log entry.
 *
 * These are the real `customer_activity_logs` columns. The interface used to
 * declare a `details` field, which does not exist on the table — the payload
 * carries `description` plus `oldValue`/`newValue`, so anything reading
 * `details` got `undefined` at runtime with no compile error.
 */
export interface CustomerActivityLog {
  id: string;
  /** Free-form. Only 'vip_changed' and 'vip_auto_recompute' are ever written today. */
  action: string;
  actorId: string | null;
  description: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * One of a customer's recent orders.
 *
 * NOT an `Order` — `CustomerService.findOne` selects exactly these eight
 * fields, so `itemCount`, `createdAt` and the nested `customer` are absent.
 * That is why `OrdersTable` cannot render these rows: its `OrderRow` requires
 * `itemCount` and `createdAt`.
 */
export interface CustomerOrderSummary {
  id: string;
  orderNumber: number;
  name: string;
  totalPrice: number;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  currency: string;
  externalCreatedAt: string | null;
}

/**
 * Full customer detail with recent orders and activity history.
 *
 * `findOne` uses no `select`, so it spreads the whole customer row — the extra
 * fields below are already on the wire and were simply never declared.
 */
export interface CustomerDetail extends Customer {
  /** The channel's own id for this customer (Shopify's numeric customer id). */
  externalId: string | null;
  addresses: Record<string, unknown>[] | null;
  defaultAddress: Record<string, unknown> | null;
  internalNotes: string | null;
  /** Free-text note synced from Shopify, distinct from `internalNotes`. */
  note: string | null;
  acceptsMarketing: boolean;
  verifiedEmail: boolean;
  externalCreatedAt: string | null;
  /** Capped at the 10 most recent by the server. */
  orders: CustomerOrderSummary[];
  /** Capped at the 20 most recent by the server. */
  activityLogs: CustomerActivityLog[];
  /**
   * What the order form pre-fills when this customer is picked: their saved
   * address, else their last order's delivery address — normalised to the
   * form's shape (GST `stateCode` resolved, phone in E.164). Null if none.
   */
  prefillAddress?: OrderAddressInput | null;
  /** Every WhatsApp number and Instagram or Messenger profile linked to this customer, latest first. */
  chats: CustomerChat[];
}

/** Query parameters for the customer list endpoint. */
export interface CustomerListParams {
  page?: number;
  limit?: number;
  vipLevel?: VipLevel;
  channelId?: string;
  search?: string;
  tag?: string;
  segment?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/** Payload for updating a customer's VIP level, notes, segments, or tags. */
export interface UpdateCustomerRequest {
  vipLevel?: VipLevel;
  internalNotes?: string;
  segments?: string[];
  tags?: string[];
  gstin?: string;
  billingStateCode?: string;
  billingStateName?: string;
}

// ─── Order Stats Types ──────────────────────────────────────────────────────

/** Direction of a period-over-period change. */
export type ChangeDirection = "up" | "down" | "same";

/**
 * One currency's share of a money total.
 *
 * Orders are stored in the currency the channel sold in, and nothing in the
 * schema carries an FX rate, so a workspace whose store sells in a different
 * currency cannot have its revenue expressed as one number. Totals that can
 * span currencies carry this breakdown and are rendered one line per currency.
 */
export interface CurrencyAmount {
  currency: string;
  amount: number;
  orders: number;
}

/** A single metric with current/previous values and change percentage. */
export interface StatMetric {
  current: number;
  previous: number;
  /**
   * Null for an unbounded ("All Time") window — there is no earlier period to
   * compare against, and a fabricated "100% up" against an empty one put a
   * green growth badge on every tile. The card omits its badge instead.
   */
  change: {
    percentage: number;
    direction: ChangeDirection;
  } | null;
  /** Money metrics only: what `current` is denominated in after conversion. */
  currency?: string;
  /** Orders excluded from `current` because their FX rate never resolved. */
  unconverted?: number;
  /**
   * Money metrics only: the pre-conversion make-up of `current`, largest
   * first. Supporting detail — `current` is already a single real figure.
   */
  byCurrency?: CurrencyAmount[];
}

/** Period-over-period comparison stats returned by GET /orders/stats. */
export interface OrderStatsResponse {
  period: {
    current: { from: string; to: string };
    previous: { from: string; to: string };
  };
  totalNewOrders: StatMetric;
  pendingOrders: StatMetric;
  totalSales: StatMetric;
  totalProductsSold: StatMetric;
}

// ─── Dashboard Types ────────────────────────────────────────────────────────

/** Query parameters for the dashboard overview endpoint. */
/** Pre-canned windows offered by the dashboard's period selector. */
export const DASHBOARD_RANGES = ["7d", "30d", "6m", "12m"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export interface DashboardQueryParams {
  /**
   * The window every figure on the page shares. Passing it to one query and not
   * another is what let "Total Sales" (all-time) sit beside "Total Revenue"
   * (rolling 12 months) describing different populations.
   */
  range?: DashboardRange;
  dateFrom?: string;
  dateTo?: string;
  channelId?: string;
}

/** The window a dashboard response was computed over. */
export interface DashboardPeriod {
  from: string;
  /** Exclusive. */
  to: string;
  /** "Last 12 months" — render this rather than re-deriving it. */
  label: string;
  /** The org timezone the buckets were cut in. */
  timezone: string;
}

/** Fulfillment status breakdown counts. */
export interface FulfillmentBreakdown {
  unfulfilled: number;
  fulfilled: number;
  partial: number;
  restocked: number;
}

/** A top-selling product returned by the dashboard endpoint. */
export interface DashboardTopProduct {
  externalProductId: string;
  title: string;
  image: string | null;
  totalQuantitySold: number;
  totalOrders: number;
  currentStock: number;
  price: string;
}

/** One low-stock variant — what the dashboard's Low Stock tab lists. */
export interface DashboardLowStockVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  /** Null for a single-variant product — there is no variant to name. */
  variantTitle: string | null;
  sku: string | null;
  stock: number;
  image: string | null;
  threshold: number;
}

/** A low-stock product returned by the dashboard endpoint. */
export interface DashboardLowStockProduct {
  id: string;
  title: string;
  image: string | null;
  currentStock: number;
  lowestVariantStock: number;
  variantCount: number;
  price: string;
  threshold: number;
  /** The variants at or below `threshold`, lowest stock first. */
  lowVariants: Array<{
    id: string;
    /** Null for a single-variant product — there is no variant to name. */
    title: string | null;
    sku: string | null;
    stock: number;
  }>;
  lowVariantCount: number;
}

/** A recent order returned by the dashboard endpoint (subset of full Order). */
export interface DashboardRecentOrder {
  id: string;
  orderNumber: number;
  name: string;
  totalPrice: number;
  currency: string;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  customer: OrderCustomer | null;
  /** Non-nullable, matching `Order.channel` — `channelId` is a required column. */
  channel: ChannelRef;
  itemCount: number;
  createdAt: string;
}

/** Full dashboard overview response. */
export interface DashboardOverview {
  period: DashboardPeriod;
  /**
   * Kept for the CSV/JSON export summary. The stat card reads
   * `totals.grossSales` off the sales-and-profit response instead, so the
   * headline figure and the chart beside it are the same number by
   * construction.
   */
  totalSales: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  totalInventory: number;
  fulfillmentBreakdown: FulfillmentBreakdown;
  topSellingProducts: DashboardTopProduct[];
  lowStockProducts: DashboardLowStockProduct[];
  /** The 5 most urgent low-stock variants across all products. Optional:
   *  absent from servers that predate it. */
  lowStockVariants?: DashboardLowStockVariant[];
  recentOrders: DashboardRecentOrder[];
}

// ─── Store Report Types (point of sale) ─────────────────────────────────────
// PosPaymentMethod is declared with the point-of-sale types further down.

/** Query for GET /pos/reports/summary. Days are `YYYY-MM-DD` in the org's reporting zone. */
export interface PosReportParams {
  from: string;
  /** Included. */
  to: string;
  /** A warehouse id; omitted for every store. */
  storeId?: string;
}

/**
 * Store sales over a period: POS bills less cancelled and deleted ones, paid or
 * not. Money is in `currency`, converted at each bill's stored rate.
 */
export interface PosReportSummary {
  period: { from: string; to: string; timezone: string };
  currency: string;
  totals: {
    sales: number;
    /** Bills. */
    orders: number;
    avgBill: number;
    discounts: number;
    tax: number;
    itemsSold: number;
    /** Taken against these bills, by any method. */
    paid: number;
    /** Still to collect on part-paid and unpaid bills, round-off included. */
    balanceDue: number;
  };
  /** Every day of the period, zero on days without bills. */
  byDay: Array<{ date: string; sales: number; orders: number }>;
  byStore: Array<{ storeId: string | null; storeName: string; sales: number; orders: number }>;
  /** `posStaffId` null is bills rung up without a staff PIN. */
  byStaff: Array<{
    posStaffId: string | null;
    name: string;
    sales: number;
    orders: number;
    avgBill: number;
  }>;
  /** Always all four methods, in this order: cash, UPI, card, other. */
  byPayment: Array<{ method: PosPaymentMethod; amount: number; count: number }>;
  /** Top 10 by units sold. `variantId` null is an item typed in at the counter. */
  topProducts: Array<{ variantId: string | null; title: string; quantity: number; sales: number }>;
  partPaid: { orders: number; balanceDue: number };
  /** Bills left out of every figure because their exchange rate is unknown. */
  unconvertedOrders: number;
}

/** sale, unlock, pin_failed and approval are written today; others may follow. */
export type PosActivityType = "sale" | "unlock" | "pin_failed" | "approval" | (string & {});

export interface PosActivityParams {
  from?: string;
  to?: string;
  type?: string;
  limit?: number;
}

export interface PosActivityEntry {
  id: string;
  type: PosActivityType;
  createdAt: string;
  details: Record<string, unknown> | null;
  /** Who was signed in at the till with their PIN. */
  staff: { id: string; name: string } | null;
  /** The manager whose PIN approved it. */
  approvedBy: { id: string; name: string } | null;
  order: { id: string; name: string } | null;
  /** The Collabo member the device was signed in as. */
  deviceUser: { id: string; name: string } | null;
}

export interface PosActivityResponse {
  items: PosActivityEntry[];
  /** More entries match than the page holds. */
  hasMore: boolean;
}

// ─── Customer Stats Types ──────────────────────────────────────────────────

/** New-customers metric with period-over-period comparison. */
export interface NewCustomersMetric {
  current: number;
  previous: number;
  change: {
    percentage: number;
    direction: ChangeDirection;
  };
}

/** VIP tier breakdown counts. */
export interface VipBreakdown {
  none: number;
  bronze: number;
  silver: number;
  gold: number;
  platinum: number;
}

/** Aggregate customer statistics returned by GET /customers/stats. */
export interface CustomerStatsResponse {
  totalCustomers: number;
  activeCustomers: number;
  inactiveCustomers: number;
  newCustomers: NewCustomersMetric;
  totalRevenue: number;
  averageCustomerValue: number;
  averageOrderValue: number;
  vipBreakdown: VipBreakdown;
}

// ─── Product Stats Types ───────────────────────────────────────────────────

/** Aggregate product statistics returned by GET /products/stats. */
export interface ProductStatsResponse {
  totalProducts: number;
  activeListings: number;
  draftProducts: number;
  archivedProducts: number;
  outOfStockProducts: number;
  lowStockProducts: number;
  lowStockThreshold: number;
  totalInventoryUnits: number;
}

// ─── GST Types ──────────────────────────────────────────────────────────────

/** An Indian state with its GST state code. */
export interface IndianState {
  code: string;
  name: string;
  unionTerritory: boolean;
}

/** A GSTIN registration for an organization. */
export interface OrganizationGstin {
  id: string;
  organizationId: string;
  gstin: string;
  legalName: string;
  tradeName: string | null;
  stateCode: string;
  stateName: string;
  address: Record<string, unknown> | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Payload for adding a new GSTIN registration. */
/**
 * Seller address on a GSTIN registration.
 *
 * Deliberately the same canonical keys every other address blob in the app
 * uses, so `lib/address.ts readAddress()` can render it without a fourth set
 * of aliases. Snapshotted onto `Invoice.sellerAddress` at issue time — a GST
 * tax invoice must carry the supplier's address.
 */
export interface GstinAddress {
  address1?: string;
  address2?: string;
  city?: string;
  zip?: string;
  province?: string;
}

export interface CreateGstinRequest {
  gstin: string;
  legalName: string;
  tradeName?: string;
  stateCode: string;
  stateName: string;
  address?: GstinAddress;
  isDefault?: boolean;
}

/** Payload for updating a GSTIN registration. */
export interface UpdateGstinRequest {
  gstin?: string;
  legalName?: string;
  tradeName?: string;
  stateCode?: string;
  stateName?: string;
  address?: GstinAddress;
  isDefault?: boolean;
  isActive?: boolean;
}

// ─── Invoice Types ──────────────────────────────────────────────────────────

/** GST transaction type. */
export type GstType = "CGST_SGST" | "IGST";

/** Invoice status. */
export type InvoiceStatus = "DRAFT" | "ISSUED" | "CANCELLED" | "CREDIT_NOTE";

/** An invoice line item with full tax breakdown. */
export interface InvoiceLineItem {
  id: string;
  orderLineItemId: string | null;
  description: string;
  hsnCode: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxableValue: number;
  gstRate: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  totalTax: number;
  totalAmount: number;
}

/** An invoice in a list response (summary view). */
export interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  financialYear: string;
  buyerName: string;
  buyerGstin: string | null;
  placeOfSupply: string;
  placeOfSupplyName: string;
  gstType: GstType;
  subtotal: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalTax: number;
  totalDiscount: number;
  /**
   * Shipping charged on the order, carried onto the invoice and INCLUDED in
   * `grandTotal` but not taxed. Render it as its own line or the totals ladder
   * will not sum to the grand total.
   */
  shippingCharge: number;
  grandTotal: number;
  currency: string;
  status: InvoiceStatus;
  cancelledAt: string | null;
  /** `financialStatus` drives the derived "Unpaid" pill — see `lib/invoice-status.ts`. */
  order: {
    id: string;
    name: string;
    orderNumber: number;
    financialStatus: FinancialStatus;
  };
  createdAt: string;
}

/** Full invoice detail with line items. */
export interface InvoiceDetail extends Invoice {
  sellerGstin: string;
  sellerLegalName: string;
  sellerAddress: Record<string, unknown> | null;
  sellerStateCode: string;
  sellerStateName: string;
  /**
   * Additional place of business the goods left from. All null when they left
   * from the registered address, or the org does not track warehouses — the
   * print and detail views then render no dispatch block at all.
   */
  dispatchWarehouseId: string | null;
  dispatchName: string | null;
  dispatchAddress: Record<string, unknown> | null;
  dispatchStateCode: string | null;
  buyerAddress: Record<string, unknown> | null;
  buyerStateCode: string;
  buyerStateName: string;
  reverseCharge: boolean;
  notes: string | null;
  lineItems: InvoiceLineItem[];
}

/** Payload for generating a new invoice. */
/** PATCH /invoices/:id — the non-tax fields an issued invoice may correct. */
export interface UpdateInvoiceRequest {
  buyerName?: string;
  /** Empty or null clears it; the invoice becomes B2C. */
  buyerGstin?: string | null;
  buyerAddress?: {
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
  } | null;
  notes?: string | null;
}

export interface CreateInvoiceRequest {
  orderId: string;
  sellerGstinId?: string;
  buyerGstin?: string;
  placeOfSupplyCode?: string;
  notes?: string;
  /** Additional place of business the goods left from. */
  dispatchWarehouseId?: string;
  /**
   * Whether tax is payable by the RECIPIENT under reverse charge.
   *
   * Rule 46(p) requires the invoice to declare this. The column existed since
   * the GST tables were created but nothing wrote it, so every invoice showed
   * the default and the declaration could only ever say "No".
   */
  reverseCharge?: boolean;
}

/**
 * POST /invoices/bulk — one entry per requested order. Mirrors
 * `BulkInvoiceResult` in `server/src/invoice/invoice.service.ts`.
 */
export interface BulkInvoiceResult {
  issued: Array<{
    orderId: string;
    orderName: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
  }>;
  /** Not attempted, or already invoiced. */
  skipped: Array<{ orderId: string; orderName: string | null; reason: string }>;
  /** Attempted and rejected; `reason` is the server's message. */
  failed: Array<{ orderId: string; orderName: string; reason: string }>;
}

/** A refunded order whose invoice still needs a credit note. */
export interface RefundPendingCredit {
  orderId: string;
  orderName: string;
  currency: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotal: string;
  refundedAmount: string;
  /**
   * NULL when the sales channel never reported the tax.
   *
   * Must be shown as unknown, never as zero — a credit note raised for the
   * refunded amount with no tax would reverse the sale value while leaving all
   * of its output tax declared.
   */
  refundedTax: string | null;
  /**
   * Already credited against this order, as POSITIVE amounts — credit notes
   * store the magnitudes printed on the paper document, not negatives.
   */
  creditedAmount: string;
  creditedTax: string;
  /**
   * Refunded minus already credited: what a note raised NOW should be for.
   *
   * Always > 0 (an order is dropped from this list once fully credited). Use
   * this for the prefill, never `refundedAmount` — an order that was already
   * part-credited would otherwise prefill an amount the server refuses as
   * over-crediting.
   */
  pendingAmount: string;
  /** Null for the same reason as `refundedTax`: unknown, not zero. */
  pendingTax: string | null;
  refundCount: number;
  lastRefundAt: string | null;
  reason: string | null;
}

/** Payload for POST /invoices/:id/credit-note. */
export interface CreateCreditNoteRequest {
  /** Printed on the note and reported with it in GSTR-1 table 9B. */
  reason: string;
  /**
   * Amount to credit, inclusive of tax. Omit for a FULL reversal of whatever
   * remains uncredited. A partial credit is spread across the original lines,
   * so each keeps its own GST rate, and credits goods before untaxed shipping.
   */
  amount?: number;
  /**
   * GST included in `amount`, when known (the refund reports it). The note
   * then reverses exactly this much GST; the rest beyond the goods it was
   * charged on is untaxed shipping. Sent only with `amount`.
   */
  tax?: number;
  notes?: string;
}

/** A period recorded as filed, which locks it against edits. */
export interface GstFiling {
  id: string;
  financialYear: string;
  period: string;
  returnType: "GSTR1" | "GSTR3B";
  sellerGstinId: string | null;
  filedAt: string;
  arn: string | null;
}

/**
 * What a payment supplier charged in one filing period.
 *
 * ⚠️ Never subtracted from sales. A sale keeps its full declared value however
 * much the supplier deducts before settling — the fee is a separate purchase
 * whose GST comes back as input tax credit. Nothing here feeds a return total.
 */
export interface InwardSupply {
  id: string;
  financialYear: string;
  period: string;
  supplier: string;
  /** The fee itself, excluding tax. */
  feeAmount: string;
  /**
   * NULL when the invoice never stated the tax — NOT the same as zero. Shown as
   * unknown, never as ₹0, or a claim looks settled when nobody has supplied the
   * figure yet.
   */
  gstAmount: string | null;
  supplierGstin: string | null;
  /** An import of services: GST is self-paid first, then reclaimed. */
  isReverseCharge: boolean;
  source: "MANUAL" | "SHOPIFY_SYNC";
  note: string | null;
}

export interface InwardSupplySummary {
  totalFee: number;
  /** Null when no row stated a GST amount at all. */
  totalGst: number | null;
  /** While above zero, `totalGst` is a floor rather than the full claim. */
  rowsWithUnknownGst: number;
  /** The portion self-paid under reverse charge — GSTR-3B 4(A)(3). */
  reverseChargeGst: number;
  /** The taxable value behind it — GSTR-3B 3.1(d) needs the value, not the tax. */
  reverseChargeTaxable: number;
}

export interface InwardSuppliesResponse {
  fees: InwardSupply[];
  summary: InwardSupplySummary;
}

/** Payload for PUT /inward-supplies. Idempotent on (year, period, supplier). */
export interface UpsertInwardSupplyRequest {
  financialYear: string;
  period: string;
  supplier: string;
  feeAmount: number;
  /** Omit when the invoice does not state it — omitted means unknown, not 0. */
  gstAmount?: number;
  supplierGstin?: string;
  isReverseCharge?: boolean;
  note?: string;
}

/** Payload for POST /invoices/gst-return/filings. */
export interface MarkFiledRequest {
  financialYear: string;
  period: string;
  returnType: "GSTR1" | "GSTR3B";
  sellerGstinId?: string;
  arn?: string;
}

/** Query parameters for the invoice list endpoint. */
export interface InvoiceListParams {
  page?: number;
  limit?: number;
  financialYear?: string;
  status?: InvoiceStatus;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Registered (has a GSTIN) vs. unregistered buyers — the B2B filter chip. */
  buyerType?: "B2B" | "B2C";
  /**
   * Narrows to issued invoices whose order still owes money. Derived from the
   * order's `financialStatus`; the invoice itself stores no payment state.
   */
  paymentState?: "UNPAID";
  sellerGstinId?: string;
  /** Whitelisted server-side — see `InvoiceSortField` in the query DTO. */
  sortBy?: InvoiceSortField;
  sortOrder?: "asc" | "desc";
}

/** Columns the invoice list may be ordered by. Mirrors the server enum. */
export type InvoiceSortField =
  | "invoiceDate"
  | "invoiceNumber"
  | "buyerName"
  | "subtotal"
  | "totalTax"
  | "grandTotal";

/**
 * Aggregates for the invoice KPI row and the filter-chip counts.
 *
 * Separate from the paginated list because the chips must count the whole set,
 * not the current page.
 */
export interface InvoiceStats {
  /**
   * Month-to-date figures. `changePct` is null when there is no comparable
   * prior period — `StatCard` omits the trend badge rather than rendering a
   * green "0%", which is what made a failed request look healthy.
   */
  invoicedThisMonth: { amount: number; changePct: number | null };
  taxCollected: { amount: number; changePct: number | null };
  outstanding: {
    amount: number;
    invoiceCount: number;
    changePct: number | null;
  };
  /** ISO dates bounding the month-to-date window, for the card sub-labels. */
  periodStart: string;
  periodEnd: string;
  /**
   * Drives the filter-chip counts.
   *
   * No `draft`: `InvoiceStatus.DRAFT` exists in the enum but nothing writes it,
   * so the count was structurally always 0 and drove a chip that could never
   * match. It returns alongside a real draft-invoice lifecycle.
   */
  counts: {
    all: number;
    issued: number;
    unpaid: number;
    b2b: number;
    cancelled: number;
  };
  /**
   * Paid orders whose invoice could not be issued (GST disabled, no GSTIN, an
   * invoice already live). Deliberately NOT financial-year scoped: an org
   * accruing these needs to know regardless of the year being viewed.
   *
   * A sibling of `counts`, not a member — `counts` counts INVOICES and drives
   * the filter chips; this counts ORDERS and drives a warning.
   */
  uninvoicedPaidOrders: number;
  /** Invoices whose declared tax diverged from what the sales channel charged. */
  taxMismatches: number;
  /**
   * Issued invoices carrying a line with no HSN code. GSTR-1 Table 12 cannot be
   * filed until this is zero — it is a catalogue task, not a bug.
   */
  invoicesMissingHsn: number;
  /**
   * Issued invoices dispatched from a warehouse linked to no GST registration.
   * Every place of business invoicing under a GSTIN must be declared under that
   * registration on the portal — a warning, never a block.
   */
  invoicesFromUnlinkedWarehouse: number;
  /**
   * Refunded orders whose invoice has not been credited.
   *
   * Credit notes existed but nothing surfaced the need, so a refunded sale sat
   * at full value in the return until somebody remembered — the exact problem
   * credit notes were built to solve.
   */
  refundsNeedingCreditNote: number;
  currency: string;
}

/** Query parameters for the GST return summary endpoint. */
export interface GstReturnParams {
  financialYear: string;
  period: string;
  returnType?: "GSTR1" | "GSTR3B";
  sellerGstinId?: string;
  /**
   * REFERENCE VIEW ONLY. Narrows the figures to one dispatch warehouse so a
   * merchant can see what a branch contributed. A GST return is filed per
   * GSTIN and has no warehouse dimension — never file from a scoped view.
   */
  dispatchWarehouseId?: string;
}

// ─── GST Return Types ───────────────────────────────────────────────────────

/** A B2B buyer group in GSTR-1. */
export interface Gstr1B2bEntry {
  buyerGstin: string;
  buyerName: string;
  invoiceCount: number;
  invoices: Array<{
    invoiceNumber: string;
    invoiceDate: string;
    /** Mandatory in GSTR-1 and varies per invoice within one buyer, so it
     *  travels on the invoice rather than the buyer group. The server always
     *  sent these; the type omitted them. */
    placeOfSupply: string | null;
    placeOfSupplyName: string | null;
    gstType: GstType;
    /** True puts the invoice in table 4B rather than 4A. */
    reverseCharge: boolean;
    subtotal: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
    grandTotal: number;
  }>;
  totalTaxable: number;
  totalTax: number;
}

/** One row of GSTR-1 Table 13 — documents issued. */
export interface Gstr1DocumentSeriesRow {
  nature: string;
  series: string;
  financialYear: string;
  from: string;
  to: string;
  /** Span of serials (to − from + 1). */
  total: number;
  /** Documents actually present; differs from `total` only when serials are missing. */
  documents: number;
  cancelled: number;
  netIssued: number;
}

/** A B2C state-wise summary in GSTR-1. */
export interface Gstr1B2cSummary {
  placeOfSupply: string;
  placeOfSupplyName: string;
  invoiceCount: number;
  totalTaxable: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalTax: number;
}

/** One GSTR-1 Table 12 row — keyed by HSN AND rate, with a UQC. */
export interface Gstr1HsnSummary {
  /**
   * Which HSN tab this row belongs to. The portal has split Table 12 into
   * HSN-B2B and HSN-B2C since the May-2025 return period.
   */
  recipientType: "B2B" | "B2C";
  /** Null when the product carries no HSN. Rendered as a warning, never a code. */
  hsnCode: string | null;
  description: string;
  /** Unit quantity code (NOS, PCS, KGS...). Table 12 requires one per row. */
  uqc: string;
  gstRate: number;
  quantity: number;
  totalValue: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/** Table 5 — an inter-State B2C invoice above the threshold, reported invoice-wise. */
export interface Gstr1B2clRow {
  invoiceNumber: string;
  invoiceDate: string;
  placeOfSupply: string;
  placeOfSupplyName: string;
  gstRate: number;
  taxableValue: number;
  igst: number;
  invoiceValue: number;
}

/** Table 7 — other B2C supplies, by place of supply AND rate. */
export interface Gstr1B2csRow {
  placeOfSupply: string;
  placeOfSupplyName: string;
  gstRate: number;
  supplyType: "INTER" | "INTRA";
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/** One GSTR-1 Table 9B row — a credit note against an earlier invoice. */
export interface Gstr1CreditNoteRow {
  /**
   * CDNR when the buyer is registered. CDNUR only for an unregistered buyer
   * whose original invoice was B2CL or an export; a note against an ordinary
   * B2C sale is netted out of B2CS instead and has no row here.
   */
  section: "CDNR" | "CDNUR";
  /** CDNUR's "UR type": B2CL, EXPWP or EXPWOP. Null on CDNR. */
  urType: "B2CL" | "EXPWP" | "EXPWOP" | null;
  noteNumber: string;
  noteDate: string;
  buyerGstin: string | null;
  buyerName: string;
  originalInvoiceNumber: string | null;
  placeOfSupply: string;
  placeOfSupplyName: string;
  reason: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  noteValue: number;
}

/** Table 8 — supplies attracting no tax, split three ways. */
export interface Gstr1NilRatedRow {
  /** 8A / 8B / 8C / 8D. */
  section: string;
  description: string;
  nilRated: number;
  exempted: number;
  nonGst: number;
}

/** Full GSTR-1 return data. */
export interface GstReturnGstr1 {
  b2b: Gstr1B2bEntry[];
  /** Table 5 — invoice-wise, above the B2C large-invoice threshold. */
  b2cl: Gstr1B2clRow[];
  /** Table 7 — rate-wise. This is the filable B2C shape. */
  b2cs: Gstr1B2csRow[];
  /**
   * Per-state roll-up, retained for the summary panel. NOT filable on its own —
   * it mixes every rate into one row per state, which is what b2cl/b2cs fix.
   */
  b2cSummary: Gstr1B2cSummary[];
  hsnSummary: Gstr1HsnSummary[];
  /**
   * Table 13 — documents issued. Absent on GSTR-3B, and on any response from a
   * server that predates it.
   */
  documentsIssued?: {
    rows: Gstr1DocumentSeriesRow[];
    /** Invoice numbers that carried no readable serial. */
    unparsed: number;
  };
  /** Table 8 — nil-rated, exempted and non-GST outward supplies. */
  nilRated: Gstr1NilRatedRow[];
  /** Table 9B — credit notes against earlier invoices (CDNR / CDNUR). */
  creditNotes: Gstr1CreditNoteRow[];
  totals: {
    totalTaxable: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
    totalTax: number;
    totalInvoices: number;
    /** Lines with no HSN. Must reach zero before Table 12 can be filed. */
    linesMissingHsn: number;
    /**
     * The tax figures above are NET of credit notes — that is what gets filed.
     * These keep the deduction visible rather than implied, and give table 12
     * (which reports invoice lines, not notes) something to reconcile against.
     */
    grossTaxable: number;
    creditNoteCount: number;
    creditNoteTaxable: number;
    creditNoteTax: number;
  };
}

/** Outward supply by rate in GSTR-3B. */
export interface Gstr3bOutwardSupply {
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
}

/** One state's row in the GSTR-3B 3.2 breakdown. */
export interface Gstr3bInterStateRow {
  placeOfSupply: string;
  placeOfSupplyName: string;
  invoiceCount: number;
  totalTaxable: number;
  totalIgst: number;
}

/** Full GSTR-3B return data. */
export interface GstReturnGstr3B {
  outwardSupplies: Gstr3bOutwardSupply[];
  /**
   * OUTWARD supplies the recipient pays tax on (GSTR-1 table 4B). Excluded
   * from 3.1(a), 3.2 and tax payable, because the portal's own 3.1(a) is built
   * from GSTR-1 tables that omit 4B.
   */
  outwardReverseCharge?: {
    invoiceCount: number;
    taxableValue: number;
    tax: number;
    /** Non-zero almost always means a mis-flagged invoice — RCM runs B2B. */
    unregisteredRecipients: number;
  };
  /**
   * 3.1(b), (c) and (e) — taxable value only, since none carries tax.
   * Before supplies were classified, every line landed in 3.1(a) and these
   * three were permanently empty.
   */
  otherSupplies: {
    zeroRated: number;
    /**
     * IGST on zero-rated supplies. An export made without an LUT is zero-rated
     * but made ON PAYMENT of IGST, and 3.1(b) has a tax column for it. Nil-rated
     * and non-GST never carry tax, so only this row has one.
     */
    zeroRatedIgst?: number;
    nilRatedExempt: number;
    nonGst: number;
  };
  interState: {
    invoiceCount: number;
    totalTaxable: number;
    totalIgst: number;
    /**
     * Per-state breakdown for GSTR-3B table 3.2 (inter-state supplies to
     * *unregistered* persons), so the aggregate above can be shown as rows.
     * Narrower than the aggregate by design: 3.2 is B2C-only, whereas the
     * totals beside it cover every inter-state invoice.
     */
    byState: Gstr3bInterStateRow[];
  };
  taxPayable: {
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
  };
}

/** Payload for updating a product's HSN code and GST rate. */
export interface UpdateProductGstRequest {
  hsnCode?: string;
  gstRate?: number;
}

// ─── State Tax Rate Types ───────────────────────────────────────────────────

/** A default GST rate configured for a specific state. */
export interface StateTaxRate {
  id: string;
  organizationId: string;
  stateCode: string;
  stateName: string;
  gstRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStateTaxRateRequest {
  stateCode: string;
  gstRate: number;
}

export interface UpdateStateTaxRateRequest {
  gstRate: number;
}

// ─── Product Type Tax Rate Types ─────────────────────────────────────────────

/** A default GST rate configured for a specific product type. */
export interface ProductTypeTaxRate {
  id: string;
  organizationId: string;
  productType: string;
  gstRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductTypeTaxRateRequest {
  productType: string;
  gstRate: number;
}

export interface UpdateProductTypeTaxRateRequest {
  gstRate: number;
}

// ─── Collection Types ───────────────────────────────────────────────────────

/** A synced Shopify collection. */
export interface ShopifyCollection {
  id: string;
  organizationId: string;
  title: string;
  handle: string | null;
  collectionType: string;
  taxOverride: CollectionTaxOverride | null;
  createdAt: string;
}

/** A GST rate override for a collection. */
export interface CollectionTaxOverride {
  id: string;
  organizationId: string;
  collectionId: string;
  gstRate: number;
  collection?: { id: string; title: string; handle: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionOverrideRequest {
  collectionId: string;
  gstRate: number;
}

export interface UpdateCollectionOverrideRequest {
  gstRate: number;
}

// ─── Inventory (Warehousing) Types ──────────────────────────────────────────

/** Physical stock buckets. Picked/Packed are pick-task states, not buckets. */
export type StockBucket = "AVAILABLE" | "RESERVED" | "QC" | "DAMAGED";

export interface InventoryStatus {
  warehousingEnabled: boolean;
  seeding: boolean;
  qcOnReceiving: boolean;
  requireScanToPick: boolean;
  skuPrefix: string;
  lowStockThreshold: number;
  warehouseCount: number;
}

/** A Store sells with the point of sale; a Warehouse only holds stock. */
export type LocationKind = "STORE" | "WAREHOUSE";

/**
 * Which GST registration a location's sales are billed under. `existing` uses
 * one of the workspace's GSTINs for the location's state, `new` adds the
 * location's own, and `none` leaves it without one.
 */
export type LocationGstChoice =
  | { mode: "existing"; gstinId: string }
  | { mode: "new"; gstin: string; legalName?: string; tradeName?: string }
  | { mode: "none" };

/** Whose counts win when a location that already holds stock is linked to Shopify. */
export type LocationStockSource = "shopify" | "collabo";

export interface LocationAddress {
  address1: string;
  address2?: string;
  city: string;
  zip: string;
  stateCode: string;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  kind: LocationKind;
  shopifyLocationId: string | null;
  /** The Shopify location this one shares stock with. */
  shopifyLocation: { id: string; name: string } | null;
  /** A sentence about this location's GST setup that needs the merchant's attention. */
  gstWarning: string | null;
  address: Record<string, unknown> | null;
  /** GST registration this warehouse is an additional place of business of. */
  gstinId: string | null;
  /** Merchant's own confirmation that the APOB is declared on the GST portal. */
  apobDeclared: boolean;
  isDefault: boolean;
  isActive: boolean;
  locationCount: number;
  stockLineCount: number;
  /** Sellable units held here — shown beside the name in the location picker. */
  unitsAvailable: number;
  createdAt: string;
}

export interface WarehouseLocation {
  id: string;
  parentId: string | null;
  type: "ZONE" | "RACK" | "SHELF" | "BIN";
  code: string;
  fullCode: string;
}

/** One stock line: variant × warehouse with bucket quantities. */
export interface StockLine {
  id: string;
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
  sku: string | null;
  barcode: string | null;
  cost: number | string | null;
  price: number | string;
  warehouse: { id: string; name: string; code: string };
  defaultLocation: string | null;
  available: number;
  reserved: number;
  qc: number;
  damaged: number;
  onHand: number;
  updatedAt: string;
}

export interface StockStats {
  unitsAvailable: number;
  unitsReserved: number;
  unitsQc: number;
  unitsDamaged: number;
  unitsOnHand: number;
  lowStockLines: number;
  oversoldLines: number;
  stockValue: number;
  lowStockThreshold: number;
}

export interface StockListParams {
  page?: number;
  limit?: number;
  warehouseId?: string;
  q?: string;
  stockFilter?: "low" | "out" | "oversold";
  sortBy?: "product" | "available" | "onHand" | "updatedAt" | "sku";
  sortOrder?: "asc" | "desc";
}

export interface InventoryEvent {
  id: string;
  variantId: string;
  quantityBefore: number;
  quantityAfter: number;
  changeAmount: number;
  movedQty: number | null;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  warehouseId: string | null;
  fromBucket: StockBucket | null;
  toBucket: StockBucket | null;
  skuSnapshot: string | null;
  createdAt: string;
  // Enriched by the ledger endpoint:
  variantTitle: string | null;
  productTitle: string | null;
  sku: string | null;
}

export interface LedgerParams {
  page?: number;
  limit?: number;
  variantId?: string;
  warehouseId?: string;
  reason?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** Keep in step with ADJUSTMENT_REASONS on the server. */
export type AdjustmentReason =
  | "adjustment"
  | "count"
  | "damage"
  | "found"
  | "correction"
  | "received"
  | "restock"
  | "shrinkage"
  | "quality"
  | "other";

export interface CreateAdjustmentRequest {
  variantId: string;
  /** Required for warehousing orgs — the location the write lands on. */
  warehouseId: string;
  bucket: StockBucket;
  delta?: number;
  setTo?: number;
  reason?: AdjustmentReason;
  note?: string;
}

/** The full set of locations a variant is stocked at — sent whole. */
export interface SetVariantLocationsRequest {
  warehouseIds: string[];
}

export interface SetVariantLocationsResponse {
  ok: boolean;
  added: number;
  removed: number;
  /** A Shopify location changed, so the product now needs a sync. */
  needsShopifySync: boolean;
}

export interface BulkAdjustmentRequest {
  warehouseId: string;
  items: Array<{
    variantId: string;
    bucket: StockBucket;
    delta?: number;
    setTo?: number;
  }>;
  reason?: AdjustmentReason;
  note?: string;
}

export interface BulkAdjustmentResponse {
  ok: boolean;
  applied: number;
  results: Array<{
    variantId: string;
    bucket: StockBucket;
    delta: number;
    changed: boolean;
    inventoryQuantity: number;
  }>;
}

export interface GenerateCodesRequest {
  variantIds?: string[];
  /**
   * `missing-or-generated` (barcodes only) targets variants with no barcode
   * plus those whose barcode the CRM minted. Use it instead of `overwrite`
   * when switching a catalogue to short codes — `overwrite` bypasses filtering
   * altogether and would clobber real GTINs synced from Shopify.
   */
  filter?: "missing-sku" | "missing-barcode" | "missing-or-generated" | "all";
  overwrite?: boolean;
  /**
   * Barcode value shape (generate-barcodes only). "short" mints a 6-digit
   * numeric code that fits small and jewellery label stock, which an
   * 18-character SKU cannot — it is the default. "sku" copies the SKU
   * verbatim, the original behaviour.
   */
  format?: "sku" | "short";
}

/**
 * Org-wide code coverage, behind the "Product codes" dialog. Each figure is
 * the exact target set of one action, so a zero means that action has nothing
 * to do and is not offered.
 */
export interface CodeStatus {
  totalVariants: number;
  missingSku: number;
  missingBarcode: number;
  /** CRM-generated barcodes too long to print on small label stock. */
  longBarcode: number;
  /**
   * The prefix a generated SKU will actually start with — already resolved
   * through the org-name fallback, so do not re-derive it here.
   */
  skuPrefix: string;
}

export interface GenerateCodesResult {
  generated: number;
  skipped: number;
  conflicts: Array<{ variantId: string; reason: string }>;
}

export interface InventoryLookupResult {
  code: string;
  matchedBy: "barcode" | "sku" | null;
  matches: Array<{
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: number | string;
    inventoryQuantity: number;
    product: { id: string; title: string; images: Array<{ src: string }> };
    stockLevels: Array<{
      warehouseId: string;
      available: number;
      reserved: number;
      qc: number;
      damaged: number;
      defaultLocation: { fullCode: string } | null;
    }>;
  }>;
}

export interface VariantStockDetail {
  variant: {
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    inventoryQuantity: number;
    product: { id: string; title: string };
  };
  levels: Array<{
    id: string;
    warehouseId: string;
    available: number;
    reserved: number;
    qc: number;
    damaged: number;
    warehouse: { id: string; name: string; code: string };
    defaultLocation: { fullCode: string } | null;
  }>;
  reservations: Array<{
    id: string;
    orderId: string;
    quantity: number;
    status: string;
    createdAt: string;
  }>;
  recentEvents: Array<{
    id: string;
    reason: string;
    changeAmount: number;
    movedQty: number | null;
    fromBucket: StockBucket | null;
    toBucket: StockBucket | null;
    createdAt: string;
  }>;
}

export interface CreateWarehouseRequest {
  name: string;
  code: string;
  kind: LocationKind;
  address: LocationAddress;
  /** Sent only while GST is on for the workspace. */
  gst?: LocationGstChoice;
  /** Merchant's own confirmation that the address is declared on the GST portal. */
  apobDeclared?: boolean;
  isDefault?: boolean;
  shopifyLocationId?: string;
  /** Required when linking to Shopify a location that already holds stock. */
  stockSource?: LocationStockSource;
}

export interface UpdateWarehouseRequest {
  name?: string;
  code?: string;
  kind?: LocationKind;
  address?: LocationAddress;
  gst?: LocationGstChoice;
  apobDeclared?: boolean;
  isDefault?: boolean;
  isActive?: boolean;
  /** null unlinks the Shopify location; omit to leave it unchanged. */
  shopifyLocationId?: string | null;
  stockSource?: LocationStockSource;
}

export interface BulkLocationsRequest {
  racks: number;
  shelvesPerRack: number;
  binsPerShelf: number;
  letterRacks?: boolean;
}

export interface DuplicateCodesReport {
  duplicateSkus: Array<{ code: string; count: number; variantIds: string[] }>;
  duplicateBarcodes: Array<{ code: string; count: number; variantIds: string[] }>;
}

export interface InventorySettings {
  warehousingEnabled: boolean;
  qcOnReceiving: boolean;
  requireScanToPick: boolean;
  skuPrefix: string;
  skuSequence: number;
  updateCostOnReceipt: boolean;
  /**
   * Include CRM-generated barcodes in Shopify product pushes. Default false —
   * a generated code is an internal number, not a GTIN, and the push serialises
   * the whole variant row, so without this gate it would silently occupy the
   * Shopify barcode field a real GTIN belongs in.
   */
  pushGeneratedBarcodes: boolean;
}

export interface UpdateInventorySettingsRequest {
  qcOnReceiving?: boolean;
  requireScanToPick?: boolean;
  skuPrefix?: string;
  updateCostOnReceipt?: boolean;
  pushGeneratedBarcodes?: boolean;
}

/** One printable label definition (per variant; qty chosen at print time). */
export interface LabelData {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  price: number | string;
  defaultQty: number;
}

// ─── Inbox Types ────────────────────────────────────────────────────────────
// Mirrors server/src/inbox. Dates arrive as ISO strings.

export type ConversationStatus = "OPEN" | "SNOOZED" | "CLOSED";
export type InboxListView = "all" | "mine" | "unassigned";
export type InboxListStatus = "open" | "snoozed" | "closed" | "any";
export type MessageDirection = "INBOUND" | "OUTBOUND";
/** PLAYED: a voice note the customer has listened to; it comes after READ. */
export type InboxMessageStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "PLAYED" | "FAILED";
export type InboxMessageKind =
  | "TEXT"
  | "TEMPLATE"
  | "DOCUMENT"
  | "IMAGE"
  | "PRIVATE_REPLY"
  | "VIDEO"
  | "AUDIO"
  | "STICKER"
  | "LOCATION"
  | "CONTACTS"
  | "INTERACTIVE"
  | "REACTION"
  | "PRODUCT"
  | "ORDER"
  | "SYSTEM"
  | "UNSUPPORTED"
  | "COMMENT";
/** Who sent an outbound message, or that the customer did. */
export type MessageSource =
  | "CUSTOMER"
  | "AGENT"
  | "AUTOMATION"
  | "BROADCAST"
  | "BUSINESS_APP"
  | "OTHER_APP"
  | "SYSTEM";
export type InboxAvailability = "ONLINE" | "AWAY";
export type InboxPresence = "online" | "away" | "offline";
export type InboxShareScope = "PERSONAL" | "TEAM" | "ORGANIZATION";
export type InboxMediaKind = "image" | "video" | "audio" | "document";

export interface InboxPerson {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface InboxTeamRef {
  id: string;
  name: string;
}

export interface ReplyWindowState {
  open: boolean;
  /** WhatsApp: when free-form replies stop. Null until the customer writes. */
  closesAt: string | null;
  /** Messenger / Instagram: a person may still reply until here. */
  humanAgentUntil: string | null;
}

export interface InboxConversation {
  id: string;
  platform: ChannelPlatform;
  status: ConversationStatus;
  snoozedUntil: string | null;
  channel: { id: string; name: string; platform: ChannelPlatform };
  contact: {
    id: string;
    name: string;
    username: string | null;
    phone: string | null;
    avatarUrl: string | null;
    tags: string[];
    optedOut: boolean;
    blocked: boolean;
    /** A WhatsApp group's chat, not a person. */
    isGroup: boolean;
  };
  group: { id: string; status: WhatsAppGroupStatus; participantCount: number } | null;
  customerId: string | null;
  assignee: InboxPerson | null;
  team: InboxTeamRef | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unreadCount: number;
  awaitingReplySince: string | null;
  window: ReplyWindowState;
}

// ─── WhatsApp calls ─────────────────────────────────────────────────────────

export type WhatsAppCallStatus = "RINGING" | "CONNECTING" | "ACTIVE" | "COMPLETED" | "MISSED" | "REJECTED" | "FAILED";

export interface WhatsAppCallView {
  id: string;
  conversationId: string | null;
  direction: "USER_INITIATED" | "BUSINESS_INITIATED";
  status: WhatsAppCallStatus;
  contactName: string;
  phone: string | null;
  agentUserId: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  failure: string | null;
  /** Meta's answer to a business call has arrived. */
  hasAnswer: boolean;
}

export interface WhatsAppCallDetail extends WhatsAppCallView {
  offerSdp: string | null;
  answerSdp: string | null;
}

export interface CallPermission {
  status: string;
  canCall: boolean;
  canAsk: boolean;
}

export interface CallSettings {
  available: boolean;
  reason: string | null;
  enabled: boolean;
  showCallButton: boolean;
  callbackPermission: boolean;
}

// ─── WhatsApp groups ────────────────────────────────────────────────────────

export type WhatsAppGroupStatus = "CREATING" | "ACTIVE" | "SUSPENDED" | "DELETING" | "DELETED" | "FAILED";

export interface WhatsAppGroupSummary {
  id: string;
  channelId: string;
  channelName: string;
  subject: string;
  description: string | null;
  joinApprovalMode: "auto_approve" | "approval_required";
  inviteLink: string | null;
  status: WhatsAppGroupStatus;
  statusReason: string | null;
  participantCount: number;
  pendingJoinRequests: number;
  conversationId: string | null;
  createdAt: string;
}

export interface WhatsAppGroupDetail extends WhatsAppGroupSummary {
  participants: Array<{ waId: string; name: string | null; joinedAt: string }>;
  joinRequests: Array<{ id: string; waId: string; requestedAt: string }>;
}

export interface WhatsAppGroupsResponse {
  /** The organization's WhatsApp numbers, and whether each can run groups. */
  numbers: Array<{ channelId: string; name: string; available: boolean; reason: string | null }>;
  groups: WhatsAppGroupSummary[];
}

export interface CreateGroupRequest {
  channelId: string;
  subject: string;
  description?: string;
  joinApprovalMode: "auto_approve" | "approval_required";
}

export interface InboxCursor {
  beforeAt: string | undefined;
  beforeId: string;
}

export interface InboxConversationPage {
  items: InboxConversation[];
  nextCursor: InboxCursor | null;
}

export interface InboxCustomerMatch {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ordersCount: number;
}

/** One of a customer's chats: a WhatsApp number or an Instagram or Messenger profile. */
export interface CustomerChat {
  contactId: string;
  platform: ChannelPlatform;
  channel: { name: string };
  name: string;
  phone: string | null;
  username: string | null;
  /** Null for a contact who has no chat yet, such as an imported number. */
  conversationId: string | null;
  lastMessageAt: string | null;
}

export interface InboxOtherChat extends CustomerChat {
  lastMessagePreview: string | null;
  optedIn: boolean;
}

export interface InboxContactDetail {
  id: string;
  platform: ChannelPlatform;
  /** A WhatsApp group's chat, not a person. */
  isGroup: boolean;
  name: string;
  displayName: string | null;
  addressBookName: string | null;
  username: string | null;
  phone: string | null;
  externalId: string;
  avatarUrl: string | null;
  tags: string[];
  attributes: Record<string, string | number | boolean>;
  optedOutAt: string | null;
  optInAt: string | null;
  blockedAt: string | null;
  firstSeenAt: string;
  lastInboundAt: string | null;
  owner: { user: InboxPerson | null; team: InboxTeamRef | null };
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    ordersCount: number;
    totalSpent: string;
    vipLevel: VipLevel;
    tags: string[];
    since: string;
    recentOrders: Array<{
      id: string;
      name: string;
      totalPrice: string;
      currency: string;
      financialStatus: FinancialStatus;
      fulfillmentStatus: FulfillmentStatus;
      createdAt: string;
      cancelledAt: string | null;
    }>;
  } | null;
  phoneMatches: InboxCustomerMatch[];
  /** The same customer's other numbers and profiles, latest first. Chats the member cannot open are left out. */
  otherChats: InboxOtherChat[];
  consent: Array<{ type: "OPT_IN" | "OPT_OUT"; source: string; occurredAt: string }>;
  /** The latest click-to-message ad this person came from. */
  fromAd: { adId: string; headline: string | null; body: string | null; sourceUrl: string | null; mediaUrl: string | null; occurredAt: string } | null;
}

export interface InboxConversationDetail extends Omit<InboxConversation, "contact"> {
  contact: InboxContactDetail;
  reply: { canReply: boolean; window: ReplyWindowState };
}

export interface InboxMedia {
  mime: string | null;
  filename: string | null;
  size: number | null;
  voice: boolean;
  /** A voice note we sent: its length, as the server measured it. */
  durationMs?: number | null;
  /** Signed, expiring link; null while the file is still downloading. */
  url: string | null;
  pending: boolean;
  error: string | null;
}

export interface InboxCommentDetails {
  postId: string | null;
  parentId: string | null;
  mediaProductType: string | null;
  post: { permalink: string | null; thumbnailUrl: string | null; caption: string | null } | null;
  privateReplied: boolean;
  publicReplied: boolean;
}

/** The structured parts of a message beyond its text; shape depends on kind. */
export interface InboxMessageDetails {
  payload?: Record<string, unknown> & { type?: string };
  order?: { catalog_id?: string; text?: string; product_items?: Array<{ product_retailer_id: string; quantity: number; item_price: number; currency: string }> } | null;
  location?: { latitude: number; longitude: number; name?: string; address?: string } | null;
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }> | null;
  reply?: Record<string, unknown> | null;
  referral?: Record<string, unknown>;
  comment?: InboxCommentDetails;
}

export interface InboxMessage {
  id: string;
  direction: MessageDirection;
  kind: InboxMessageKind;
  source: MessageSource;
  text: string | null;
  status: InboxMessageStatus;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  /** History imported from the WhatsApp Business app. */
  imported: boolean;
  editedAt: string | null;
  revokedAt: string | null;
  /** { customer?: emoji, business?: emoji } */
  reactions: Record<string, string | null> | null;
  templateName: string | null;
  sentBy: { id: string; name: string | null } | null;
  /** In a WhatsApp group: the participant who wrote it. */
  groupSender: { waId: string; name: string | null } | null;
  replyTo: { id: string; text: string | null; kind: InboxMessageKind; direction: MessageDirection } | null;
  media: InboxMedia | null;
  details: InboxMessageDetails | null;
}

export interface InboxNote {
  id: string;
  body: string;
  mentions: string[];
  createdAt: string;
  /** Set when no member wrote it. */
  source: "automation" | "inbox_rule" | null;
  author: { id: string; name: string } | null;
}

export interface InboxMessagePage {
  messages: InboxMessage[];
  notes: InboxNote[];
  nextCursor: InboxCursor | null;
}

export interface InboxCounts {
  mine: number;
  unassigned: number;
  all: number;
  unread: number;
  teams: Record<string, number>;
  views: Record<string, number>;
}

export interface InboxMember extends InboxPerson {
  role: UserRole;
  presence: InboxPresence;
  teamIds: string[];
}

export interface InboxMe {
  userId: string;
  status: InboxAvailability;
  teams: InboxTeamRef[];
  access: {
    seesAll: boolean;
    seesUnassigned: boolean;
    canReply: boolean;
    canAssignOthers: boolean;
    canManage: boolean;
  };
}

export interface InboxTeam {
  id: string;
  name: string;
  openConversations: number;
  members: Array<{ id: string; name: string; presence: InboxPresence }>;
}

export interface QuickReplyAttachment {
  storageKey: string;
  mime: string;
  filename: string | null;
  mediaKind: InboxMediaKind;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
  keywords: string[];
  attachment: QuickReplyAttachment | null;
  scope: InboxShareScope;
  team: InboxTeamRef | null;
  canEdit: boolean;
  updatedAt: string;
}

export interface SaveQuickReplyRequest {
  shortcut: string;
  body: string;
  keywords?: string[];
  attachment?: QuickReplyAttachment | null;
  scope: InboxShareScope;
  teamId?: string;
}

/** Same shape as the conversation list query, minus the cursor. */
export interface InboxFilters {
  view?: InboxListView;
  status?: InboxListStatus;
  channelId?: string;
  platform?: ChannelPlatform;
  tag?: string;
  /** A team id, or "none". */
  teamId?: string;
  assigneeId?: string;
  unread?: boolean;
  comments?: boolean;
  search?: string;
}

export interface InboxSavedView {
  id: string;
  name: string;
  filters: InboxFilters;
  scope: InboxShareScope;
  team: InboxTeamRef | null;
  position: number;
  canEdit: boolean;
}

export interface SaveInboxViewRequest {
  name: string;
  filters: InboxFilters;
  scope: InboxShareScope;
  teamId?: string;
}

export interface InboxUpload {
  storageKey: string;
  mime: string;
  size: number;
  filename: string;
  mediaKind: InboxMediaKind;
  /** Voice uploads only: the recording's length. */
  durationMs?: number;
}

/** What the composer can send. Mirrors the server's send payload schema. */
export type InboxSendPayload =
  | { type: "text"; text: string }
  | { type: "media"; mediaKind: InboxMediaKind; storageKey: string; mime: string; filename?: string; caption?: string; voice?: boolean }
  | { type: "buttons"; text: string; buttons: Array<{ id: string; title: string }>; footer?: string }
  | { type: "quick_replies"; text: string; replies: Array<{ title: string; payload: string }> }
  | { type: "reaction"; messageId: string; emoji: string }
  | { type: "private_reply"; commentMessageId: string; text: string }
  | { type: "comment_reply"; commentMessageId: string; text: string }
  /** WhatsApp: one product, or a list of up to 30, from the number's catalog. */
  | { type: "products"; variantIds: string[]; header?: string; text?: string; format?: "list" | "cards" }
  | { type: "catalog"; text: string }
  | {
      type: "template";
      name: string;
      language: string;
      category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
      components?: unknown[];
      headerMedia?: { storageKey: string; mime: string; kind: "image" | "video" | "document"; filename?: string };
      /** The body as this person reads it, for the thread. Never sent to Meta. */
      previewText?: string;
    };

export type InboxSendRefusal =
  | "channel_unavailable"
  | "contact_blocked"
  | "opted_out"
  | "window_closed"
  | "unsupported_on_platform"
  | "invalid_payload";

export type InboxSendOutcome =
  | { ok: true; messageId: string; duplicate?: boolean }
  | { ok: false; code: InboxSendRefusal; message: string };

export type InboxBulkAction = "assign" | "team" | "close" | "reopen" | "snooze" | "mark_read" | "tag" | "untag";

export interface InboxBulkRequest {
  ids: string[];
  action: InboxBulkAction;
  assignedUserId?: string | null;
  teamId?: string | null;
  snoozedUntil?: string;
  tag?: string;
}

export interface InboxBulkResult {
  updated: number;
  skipped: Array<{ id: string; reason: string }>;
}

export interface UpdateInboxContactRequest {
  displayName?: string;
  tags?: string[];
  attributes?: Record<string, string | number | boolean | null>;
  customerId?: string | null;
  blocked?: boolean;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}

export interface InboxContactRow {
  id: string;
  name: string;
  platform: ChannelPlatform;
  channel: { id: string; name: string };
  phone: string | null;
  username: string | null;
  avatarUrl: string | null;
  tags: string[];
  /** A recorded opt-in, not withdrawn. */
  optedIn: boolean;
  optedOut: boolean;
  blocked: boolean;
  customer: { id: string; name: string | null } | null;
  owner: { user: InboxPerson | null; team: InboxTeamRef | null };
  lastInboundAt: string | null;
  createdAt: string;
  conversationId: string | null;
}

export interface InboxContactQuery {
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "lastInboundAt";
  sortOrder?: "asc" | "desc";
  search?: string;
  platform?: ChannelPlatform;
  channelId?: string;
  tag?: string;
  ownerUserId?: string;
  ownerTeamId?: string;
  consent?: "subscribed" | "opted_out" | "blocked";
  from?: string;
  to?: string;
}

/** One live inbox change; the stream names ids, never content. */
export type InboxStreamEvent =
  | { type: "conversation.updated"; conversationId: string }
  | { type: "message.created"; conversationId: string; messageId: string }
  | { type: "message.updated"; conversationId: string; messageId: string }
  | { type: "note.created"; conversationId: string; noteId: string }
  | { type: "call.updated"; conversationId: string; callId: string };

// ─── Campaign Types ─────────────────────────────────────────────────────────
// Mirrors server/src/campaigns.

export type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type ParameterFormat = "POSITIONAL" | "NAMED";
export type HeaderMediaFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

export type TemplateDraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example?: string }
  | { type: "PHONE_NUMBER"; text: string; phoneNumber: string }
  | { type: "COPY_CODE"; example: string };

export interface TemplateDraft {
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat: ParameterFormat;
  header?:
    | { format: "TEXT"; text: string; example?: string }
    | { format: HeaderMediaFormat; storageKey?: string; mime?: string; filename?: string }
    | { format: "LOCATION" };
  body: { text: string; examples: Record<string, string> };
  footer?: string;
  buttons?: TemplateDraftButton[];
}

/** One value a template send has to supply. */
export interface TemplateParam {
  /** header, body.1, body.first_name, button.0, coupon.1 */
  key: string;
  component: "header" | "body" | "button";
  kind: "text" | "image" | "video" | "document" | "location" | "coupon_code";
  name: string;
  buttonIndex?: number;
  example?: string;
}

export interface TemplateRender {
  header: string | null;
  headerFormat: string | null;
  body: string;
  footer: string | null;
  buttons: string[];
}

export interface MessageTemplate {
  id: string;
  externalId: string | null;
  name: string;
  language: string;
  category: TemplateCategory;
  /** What the business asked for, when Meta approved it as another category. */
  requestedCategory: TemplateCategory | null;
  /** Meta's status: PENDING, APPROVED, REJECTED, PAUSED, DISABLED, … */
  status: string;
  statusReason: string | null;
  qualityScore: string | null;
  parameterFormat: ParameterFormat;
  components: Array<Record<string, unknown>>;
  params: TemplateParam[];
  preview: TemplateRender;
  draft: TemplateDraft;
  editable: boolean;
  starterKey: string | null;
  submittedAt: string | null;
  syncedAt: string | null;
  updatedAt: string;
}

export interface TemplateStarter {
  key: string;
  useCase: "orders" | "shipping" | "payments" | "recovery" | "promotions" | "engagement";
  title: string;
  description: string;
  draft: Omit<TemplateDraft, "language">;
}

/** Whether the AI template writer is set up on the server. */
export interface TemplateWriterStatus {
  available: boolean;
  draftsPerDay: number;
}

export interface WriteTemplateRequest {
  brief: string;
  language: string;
  category?: "MARKETING" | "UTILITY";
}

/** A draft written by AI for the template editor; nothing has gone to Meta yet. */
export interface WrittenTemplate {
  draft: TemplateDraft;
  notes: string;
  model: string;
}

export interface CampaignUpload {
  storageKey: string;
  mime: string;
  size: number;
  filename: string;
  kind: "image" | "video" | "document";
}

export type RfmGroup = "champions" | "loyal" | "new" | "needs_attention" | "at_risk" | "hibernating" | "lost";

export type SegmentRule =
  | { field: "tag"; op: "has" | "not_has"; value: string }
  | { field: "channel"; op: "is" | "is_not"; value: string }
  | { field: "attribute"; key: string; op: "equals" | "not_equals" | "contains" | "exists" | "not_exists"; value?: string }
  | { field: "consent"; op: "is"; value: "opted_in" | "not_opted_out" | "opted_out" }
  | { field: "last_message"; op: "within_days" | "before_days" | "never"; value?: number }
  | { field: "first_seen"; op: "within_days" | "before_days"; value: number }
  | { field: "customer"; op: "linked" | "not_linked" }
  | { field: "orders_count"; op: "gte" | "lte" | "eq"; value: number }
  | { field: "total_spent"; op: "gte" | "lte"; value: number }
  | { field: "last_order"; op: "within_days" | "before_days"; value: number }
  | { field: "vip"; op: "in"; value: VipLevel[] }
  | { field: "rfm"; op: "in"; value: RfmGroup[] }
  /** A customer segment from the Shopify admin, linked under Segments; value is the linked segment's id. */
  | { field: "shopify_segment"; op: "in" | "not_in"; value: string }
  | { field: "broadcast"; op: "received" | "read" | "replied" | "clicked" | "not_read" | "failed"; value: string };

export interface ShopifySegmentView {
  id: string;
  externalId: string;
  name: string;
  query: string | null;
  memberCount: number | null;
  /** Members Collabo has as store customers. */
  matchedCount: number | null;
  syncedAt: string | null;
  lastError: string | null;
}

export interface ShopifySegmentsList {
  connected: boolean;
  error: string | null;
  linked: ShopifySegmentView[];
  available: Array<{ externalId: string; name: string; query: string | null }>;
}

export interface SegmentDefinition {
  match: "all" | "any";
  rules: SegmentRule[];
}

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  definition: SegmentDefinition;
  lastCount: number | null;
  lastCountedAt: string | null;
  updatedAt: string;
}

export interface SegmentPreview {
  count: number;
  sample: Array<{ id: string; name: string; platform: ChannelPlatform; phone: string | null; username: string | null; tags: string[] }>;
}

export type BroadcastStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type BroadcastRecipientStatus = "PENDING" | "SKIPPED" | "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";

export interface BroadcastAudience {
  everyone: boolean;
  segmentIds: string[];
  tags: string[];
  exclude: { segmentIds: string[]; tags: string[]; broadcastIds: string[]; messagedWithinHours: number | null };
  requireOptIn: boolean;
}

export type VariableSourceKind = "static" | "first_name" | "full_name" | "phone" | "attribute" | "customer_name" | "customer_email";

export interface VariableSource {
  source: VariableSourceKind;
  value?: string;
  fallback?: string;
}

export interface BroadcastVariables {
  values: Record<string, VariableSource>;
  headerMedia?: { storageKey: string; mime: string; kind: "image" | "video" | "document"; filename?: string };
  headerLocation?: { latitude: number; longitude: number; name?: string; address?: string };
}

export interface BroadcastStats {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
  skipped: number;
  byStatus: Partial<Record<BroadcastRecipientStatus, number>>;
}

export interface Broadcast {
  id: string;
  name: string;
  campaign: string | null;
  status: BroadcastStatus;
  channelId: string;
  templateId: string | null;
  templateName: string | null;
  templateCategory: TemplateCategory | null;
  variables: BroadcastVariables;
  audience: BroadcastAudience;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: BroadcastStats;
}

export interface BroadcastDetail extends Broadcast {
  template: MessageTemplate | null;
}

export interface BroadcastPreview {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  audience: { total: number; sending: number; skipped: Record<string, number>; skippedLabels: Record<string, string> };
  limit: { tier: string; limit: number; usedToday: number | null } | null;
  cost: {
    category: TemplateCategory | null;
    totals: Array<{ currency: string; amount: number; count: number }>;
    unpriced: number;
    ratesConfigured: boolean;
  };
  sample: Array<{ contact: string; preview: TemplateRender }>;
}

export interface BroadcastRecipientRow {
  id: string;
  status: BroadcastRecipientStatus;
  skipReason: string | null;
  skipLabel: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  clickedAt: string | null;
  failedAt: string | null;
  contact: { id: string; name: string; phone: string | null; conversationId: string | null };
}

export interface MessageRate {
  countryPrefix: string;
  label: string | null;
  currency: string;
  marketing: number | null;
  utility: number | null;
  authentication: number | null;
}

export interface CampaignsOverview {
  last30Days: { broadcasts: number; sent: number; delivered: number; read: number; replied: number; clicked: number; failed: number };
  templates: Record<string, number>;
  number: {
    channelId: string;
    name: string;
    status: string;
    quality: string | null;
    messagingLimit: string | null;
    marketingMessagesApi: string | null;
    sending: WhatsAppSendingHealth | null;
  } | null;
  recent: Array<{ id: string; name: string; status: BroadcastStatus; templateName: string | null; startedAt: string | null; scheduledAt: string | null; createdAt: string }>;
}

export interface ContactImportPreview {
  headers: string[];
  sample: string[][];
  rowCount: number;
}

export interface ContactImportMapping {
  phone: string;
  name?: string;
  tags?: string;
  optIn?: string;
  attributes?: Record<string, string>;
}

export interface ContactImportResult {
  id: string;
  rowCount: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

// ─── Automation Types ───────────────────────────────────────────────────────

export type AutomationStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED";
export type AutomationRunStatus = "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "SKIPPED" | "CANCELLED";
export type AutomationPlatform = "INSTAGRAM" | "WHATSAPP" | "FACEBOOK";
export type AutomationChannelKey = "instagram" | "whatsapp" | "facebook";

export type AutomationBlockType =
  | "trigger"
  | "send_message"
  | "reply_comment"
  | "send_invoice"
  | "send_payment_link"
  | "wait"
  | "wait_for_reply"
  | "condition"
  | "add_tag"
  | "remove_tag"
  | "set_attribute"
  | "assign"
  | "set_status"
  | "add_note"
  | "http_request"
  | "store_action"
  | "post_review"
  | "sheet_add_row";

/** One block of a flow. Condition (yes / no) and wait-for-reply (replied / timeout) carry branches. */
export interface AutomationStep {
  id: string;
  type: AutomationBlockType;
  // Each block type has its own config; lib/automation-blocks.ts knows them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
  branches?: Record<string, AutomationStep[]>;
}

export interface AutomationIssue {
  stepId: string;
  code: string;
  title: string;
  body: string;
}

export interface AutomationSettings {
  oncePerContact?: "ever" | "perDay" | "never";
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  platform: AutomationPlatform | null;
  version: number;
  publishedAt: string | null;
  triggeredCount: number;
  lastTriggeredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  channel: { id: string; name: string; platform: AutomationPlatform } | null;
  ownerUser: { id: string; firstName: string; lastName: string; email: string } | null;
}

export interface AutomationDetail extends Automation {
  definition: { steps: AutomationStep[] };
  settings: AutomationSettings | null;
  issues: AutomationIssue[];
  lastErrorAt: string | null;
  publishedVersion: { id: string; version: number; publishedAt: string } | null;
  /** The draft differs from the published version that runs. */
  unpublishedChanges: boolean;
}

export interface AutomationStats {
  runs: Record<AutomationRunStatus, number>;
  total: number;
  skipReasons: Record<string, number>;
  /** Per step id: how many runs reached it, by outcome. */
  steps: Record<string, Partial<Record<AutomationRunStatus, number>>>;
  messages: { sent: number; delivered: number; read: number; failed: number; queued: number };
  daily: Array<{ day: string; runs: number; completed: number }>;
}

export interface AutomationRunRow {
  id: string;
  status: AutomationRunStatus;
  skipReason: string | null;
  error: string | null;
  version: number;
  currentStepKey: string | null;
  resumeAt: string | null;
  waitingForReply: boolean;
  createdAt: string;
  completedAt: string | null;
  contact: { id: string; name: string; platform: AutomationPlatform } | null;
  conversationId: string | null;
  steps: Array<{
    stepKey: string;
    blockType: AutomationBlockType;
    status: AutomationRunStatus;
    error: string | null;
    output: Record<string, unknown> | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
}

export interface AutomationTestStep {
  stepId: string;
  type: AutomationBlockType;
  status: "done" | "waits" | "error";
  detail: string;
  branch?: string;
}

export interface AutomationTestResult {
  contact: { id: string | null; name: string | null };
  /** The sample order an order trigger was tried with. */
  order: { name: string; payment: string; total: string } | null;
  issues: AutomationIssue[];
  steps: AutomationTestStep[];
}

export interface InstagramPost {
  id: string;
  externalId: string;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  postedAt: string | null;
  likeCount: number | null;
  commentCount: number | null;
}

export interface ConversationStarters {
  platform: "FACEBOOK" | "INSTAGRAM";
  getStarted: { enabled: boolean; payload: string };
  iceBreakers: Array<{ question: string; payload: string }>;
  persistentMenu: Array<{ title: string; type: "postback" | "web_url"; payload: string; url: string }>;
  pushedAt: string | null;
}

// ─── Inbox Rules Types ──────────────────────────────────────────────────────

export interface InboxAutoReply {
  enabled: boolean;
  message: string;
  platforms: AutomationPlatform[];
  cooldownHours: number;
}

export interface InboxRoutingRule {
  id: string;
  name: string;
  match: "all" | "any";
  conditions: Array<{ field: "message" | "platform" | "channel" | "tag" | "customer"; op: "contains" | "is" | "has" | "linked" | "vip"; value: string }>;
  assign: { mode: "user" | "team" | "round_robin"; userId: string; teamId: string };
}

export interface InboxRulesSettings {
  businessHours: { enabled: boolean; timezone: string; days: Array<{ day: number; open: string; close: string }> };
  welcome: InboxAutoReply;
  away: InboxAutoReply;
  routing: { rules: InboxRoutingRule[] };
  roundRobin: { enabled: boolean; teamId: string; maxOpenPerAgent: number };
  autoClose: { enabled: boolean; afterHours: number };
  spam: { enabled: boolean; tag: string; blockOnWhatsApp: boolean };
}

export interface InboxRulesSettingsView extends InboxRulesSettings {
  organizationTimeZone: string;
}

// ─── Commerce Types ─────────────────────────────────────────────────────────

/** One sellable variant, for the inbox's product tray. */
export interface StoreProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  price: string;
  currency: string;
  image: string | null;
  url: string | null;
  inStock: boolean;
  /** Synced to this WhatsApp number's catalog, so it can go as a product card. */
  inCatalog: boolean;
}

export interface StoreProductsResponse {
  catalog: { catalogId: string; name: string | null } | null;
  /** WhatsApp number with a catalog, not shared with the Business app. */
  canSendProducts: boolean;
  /** Shopify collections with active products, for the product panel's filter. */
  collections: Array<{ id: string; title: string; productCount: number; url: string | null }>;
  /** More variants match than were returned; search or pick a collection. */
  more: boolean;
  products: StoreProduct[];
}

export interface DraftFromCart {
  draftId: string;
  name: string | null;
  total: string;
  checkoutUrl: string | null;
  missing: string[];
  /** The cart had a draft order already; this is that one. */
  existing: boolean;
}

// ─── Payments (the organization's own Razorpay account) ────────────────────

export interface PaymentAccount {
  connected: boolean;
  provider: "RAZORPAY";
  keyId: string | null;
  livemode: boolean;
  /** The webhook URL's secret path segment; owners and admins only. */
  webhookToken: string | null;
  webhookEvents: string[];
  lastWebhookAt: string | null;
  connectedAt: string | null;
}

/** Returned once, on connect: the secret to paste into Razorpay's webhook form. */
export interface PaymentAccountConnected extends PaymentAccount {
  webhookSecret: string;
}

export type PaymentLinkStatus = "CREATED" | "PARTIALLY_PAID" | "PAID" | "EXPIRED" | "CANCELLED";

export interface PaymentLink {
  id: string;
  /** RAZORPAY: a link to pay · WHATSAPP_PAY: a Review and Pay bill in the chat (no link). */
  provider: "RAZORPAY" | "WHATSAPP_PAY";
  shortUrl: string;
  amount: string;
  currency: string;
  description: string;
  status: PaymentLinkStatus;
  orderId: string | null;
  draftOrderId: string | null;
  expiresAt: string;
  paidAt: string | null;
  paymentMethod: string | null;
  /** Paid, but the order or draft could not be updated; the payment stands. */
  followUpError: string | null;
  createdAt: string;
  /** An open link for the same order or draft was reused. */
  existing?: boolean;
}

export interface ConversationPayments {
  links: PaymentLink[];
  unpaidOrders: Array<{ id: string; name: string; totalPrice: string; currency: string; paymentGateways: string[]; createdAt: string }>;
  /** This chat's WhatsApp number has WhatsApp Pay turned on. */
  whatsappPay: boolean;
}

export interface WhatsAppPayConfiguration {
  name: string;
  provider: string | null;
  status: string;
  active: boolean;
}

export interface WhatsAppPayView {
  selected: { configurationName: string; provider: string; status: string; active: boolean; selectedAt: string } | null;
  configurations: WhatsAppPayConfiguration[];
  /** Meta's answer when the configurations could not be read. */
  error: string | null;
}

export interface CreatePaymentLinkRequest {
  orderId?: string;
  draftOrderId?: string;
  amount?: number;
  description?: string;
  expiresInHours?: number;
}

// ─── Growth tools ───────────────────────────────────────────────────────────

export interface GrowthLink {
  id: string;
  name: string;
  code: string;
  /** Collabo's short link: counts the click, then opens the chat. */
  shortUrl: string;
  /** Where it opens: wa.me, m.me or ig.me. */
  target: string | null;
  prefilledText: string | null;
  tag: string | null;
  clicks: number;
  /** WhatsApp chats whose first message carried this link's reference. */
  chats: number;
  lastClickAt: string | null;
  createdAt: string;
  channel: { id: string; name: string; platform: ChannelPlatform };
  /** The website chat button's own link. */
  isWidgetButton: boolean;
}

export interface WidgetSettings {
  button: { label: string; color: string; position: "right" | "left"; greeting: string; greetingDelaySeconds: number; prefilledText: string; hideOnMobile: boolean };
  popup: { enabled: boolean; title: string; text: string; buttonLabel: string; consentText: string; successText: string; delaySeconds: number; tag: string; defaultCountryCode: string; confirmOnWhatsApp: boolean };
}

export interface SiteWidgetView {
  configured: boolean;
  enabled: boolean;
  channelId: string | null;
  settings: WidgetSettings;
  allowedDomains: string[];
  /** The script tag's src, once saved. */
  scriptUrl: string | null;
  stats: { clicks: number; chats: number; popupViews: number; signups: number };
}

// ─── Ads ────────────────────────────────────────────────────────────────────

export interface AdAccountView {
  connected: boolean;
  externalId?: string | null;
  name?: string | null;
  currency?: string | null;
  available?: Array<{ id: string; name: string; currency: string | null }>;
  tokenExpiresAt?: string | null;
  lastError?: string | null;
}

export interface AdReportRow {
  adId: string;
  headline: string | null;
  platform: ChannelPlatform | null;
  /** People who started a chat from the ad in the period. */
  chats: number;
  /** Their orders in the 7 days after, and those orders' value in the organization's currency. */
  orders: number;
  revenue: number;
  lastChatAt: string | null;
  /** From Meta, when an ad account is connected. */
  name: string | null;
  campaign: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversationsStarted: number | null;
}

export interface AdsReport {
  period: { from: string; to: string; days: number; timeZone: string };
  currency: string;
  account: AdAccountView;
  metaError: string | null;
  totals: { chats: number; orders: number; revenue: number; spend: number | null };
  ads: AdReportRow[];
}

export interface ConversionSetting {
  channelId: string;
  name: string;
  enabled: boolean;
  datasetId: string | null;
  sent: number;
  failed: number;
}

// ─── Developers: API keys and webhooks ──────────────────────────────────────

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  /** Only when just made. */
  key?: string;
}

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdByApi: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  /** Only when just made. */
  secret?: string;
}

export interface WebhookDeliveryView {
  id: string;
  event: string;
  status: "PENDING" | "SENT" | "FAILED";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface CatalogView {
  channelId: string;
  onBusinessApp: boolean;
  catalog: {
    catalogId: string;
    name: string | null;
    productCount: number | null;
    connectedAt: string;
    lastSync?: { at: string; sent: number; removed: number; skipped: number; errors: number; handles: string[] };
  } | null;
  commerce: { cartEnabled: boolean; catalogVisible: boolean } | null;
  commerceError: string | null;
  items: Partial<Record<"SYNCED" | "ERROR" | "SKIPPED" | "REMOVED", number>>;
  problems: Array<{ variantId: string; name: string; status: string; error: string | null }>;
}

// ─── Messaging Analytics Types ──────────────────────────────────────────────

export interface MessagingAnalytics {
  period: { from: string; to: string; timeZone: string; days: number; channelId: string | null };
  volume: {
    inbound: number;
    outbound: number;
    outboundBySource: Partial<Record<"AGENT" | "AUTOMATION" | "BROADCAST" | "SYSTEM" | "BUSINESS_APP" | "OTHER_APP", number>>;
    comments: number;
    activeConversations: number;
    newPeople: number;
    byPlatform: Array<{ platform: string; inbound: number; outbound: number }>;
    daily: Array<{ day: string; inbound: number; outbound: number }>;
  };
  responses: {
    asked: number;
    answeredByPerson: number;
    firstAnswerByAutomation: number;
    unanswered: number;
    medianFirstReplySec: number | null;
    p90FirstReplySec: number | null;
    within1h: number;
  };
  resolution: { closed: number; timed: number; medianSec: number | null; p90Sec: number | null };
  agents: Array<{
    userId: string;
    name: string;
    role: string;
    replies: number;
    conversations: number;
    firstReplies: number;
    medianFirstReplySec: number | null;
    closed: number;
    openNow: number;
  }>;
  broadcasts: {
    count: number;
    recipients: number;
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    clicked: number;
    failed: number;
    skipped: number;
    items: Array<{ id: string; name: string; recipients: number; sent: number; delivered: number; read: number; replied: number; clicked: number; failed: number }>;
  };
  automations: Array<{ id: string; name: string; started: number; completed: number; failed: number; waiting: number; skipped: number; messagesSent: number; messagesRead: number }>;
  revenue: {
    windowDays: number;
    currency: string;
    ordersInPeriod: number;
    revenueInPeriod: number;
    orders: number;
    revenue: number;
    bySource: { broadcast: { orders: number; revenue: number }; automation: { orders: number; revenue: number } };
    top: Array<{ source: "broadcast" | "automation"; refId: string | null; name: string; orders: number; revenue: number }>;
  };
  cost: {
    categories: Array<{ category: string; billable: number; free: number; unpriced: number; amounts: Array<{ currency: string; amount: number }> }>;
    totals: Array<{ currency: string; amount: number }>;
    billable: number;
    free: number;
    unpriced: number;
  };
}

// ─── Reviews (Campaigns → Reviews) ─────────────────────────────────────────

/** The store's Judge.me, where reviews collected on WhatsApp are published. */
export interface ReviewAccountView {
  connected: boolean;
  provider: "JUDGEME";
  shopDomain: string | null;
  shopName: string | null;
  /** Whether Judge.me publishes new reviews without approval; null when unknown. */
  autopublish: boolean | null;
  connectedAt: string | null;
}

/** POSTED: sent to Judge.me · SAVED: kept in Collabo only, with the reason · FAILED: Judge.me refused it. */
export type ProductReviewStatus = "POSTED" | "SAVED" | "FAILED";

export interface ProductReviewView {
  id: string;
  rating: number;
  body: string;
  /** Null for a review of the shop. */
  productTitle: string | null;
  reviewerName: string;
  contactName: string;
  order: { id: string; name: string } | null;
  conversationId: string | null;
  status: ProductReviewStatus;
  reason: string | null;
  createdAt: string;
  postedAt: string | null;
}

export interface ReviewsList {
  reviews: ProductReviewView[];
  total: number;
  page: number;
  pageSize: number;
  /** Over every review, whatever the filters. */
  stats: { count: number; average: number | null; byRating: Record<number, number>; published: number };
}

// ─── Google Sheets (Campaigns → Automations → Google Sheets) ───────────────

export interface GoogleSheetView {
  id: string;
  title: string;
  url: string;
  /** The tab rows are read from and added to. */
  tab: string;
  /** created by Collabo, or picked in Google's picker. */
  origin: "created" | "picked";
  /** An active "A row is added to a sheet" automation reads it. */
  watched: boolean;
  checkedAt: string | null;
  /** Why it could not be read last time; cleared when it can. */
  lastError: string | null;
  /** The last new row that started nothing, and why. */
  skippedRow: string | null;
  createdAt: string;
}

export interface GoogleIntegration {
  /** Collabo has its Google OAuth client set up. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  sheets: GoogleSheetView[];
}

/** A sheet's column: its header, and the {{sheet.<key>}} a new row's cell arrives as. */
export interface SheetColumn {
  header: string;
  key: string;
}

// ─── Point of sale (Orders → Point of sale) ─────────────────────────────────
// Money is rupees as numbers. Prices are GST-inclusive.

export interface PosSettings {
  upiId: string | null;
  upiPayeeName: string | null;
  roundOff: boolean;
  requireStaffPin: boolean;
  /** A discount above this share of the price needs a manager's PIN. Null: never. */
  discountApprovalPercent: number | null;
  priceOverrideNeedsApproval: boolean;
  receiptWidth: 58 | 80;
  receiptFooter: string | null;
  tileVariantIds: string[];
  /** Whether Charge first asks who is buying: never, with a skip, or always. */
  customerAtCheckout: "off" | "ask" | "required";
  /** From this payable the bill needs the buyer's name and address (GST Rule 46). Null: never. */
  customerRequiredAbove: number | null;
  /** Send the bill on WhatsApp after every sale with a mobile number. */
  autoSendBill: boolean;
}

export interface PosStore {
  id: string;
  name: string;
  code: string | null;
  isDefault: boolean;
}

export type PosStaffRole = "CASHIER" | "MANAGER";

export interface PosStaffView {
  id: string;
  name: string;
  role: PosStaffRole;
  isActive: boolean;
}

export interface PosProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  imageUrl: string | null;
  /** Null when the store does not count this variant's stock. */
  stockAtStore: number | null;
  trackQuantity: boolean;
  allowOversell: boolean;
  /** Not in the contract yet; the GST estimate uses it when the server sends it. */
  gstRate?: number | null;
}

export interface PosSetup {
  settings: PosSettings;
  stores: PosStore[];
  warehousingEnabled: boolean;
  /** Active staff only. */
  staff: PosStaffView[];
  tiles: PosProduct[];
  gstEnabled: boolean;
  storeName: string;
  currency: "INR";
  billDelivery: {
    whatsapp: { connected: boolean; template: "approved" | "pending" | "missing"; templateName: string | null };
  };
}

export interface PosUnlockResult {
  staff: PosStaffView;
  staffToken: string;
  expiresAt: string;
}

export type PosApprovalReason = "discount" | "price_override";

export interface PosApprovalResult {
  approver: PosStaffView;
  approvalToken: string;
  expiresAt: string;
}

export interface PosCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  ordersCount: number;
  totalSpent: number;
  vipLevel: VipLevel;
}

export type PosPaymentMethod = "CASH" | "UPI" | "CARD" | "OTHER";

export interface PosDiscount {
  type: "percent" | "amount";
  value: number;
}

export interface PosPaymentInput {
  method: PosPaymentMethod;
  amount: number;
  /** Cash handed over, when it is more than `amount`. */
  tendered?: number;
  reference?: string;
}

export interface PosAddressInput {
  address1: string;
  city: string;
  zip: string;
  stateCode: string;
}

/**
 * A phone given for the bill is consent for the bill itself; `offersOptIn` is
 * marketing consent, sent only when the customer agreed.
 */
export interface PosSaleCustomerInput {
  customerId?: string;
  phone?: string;
  name?: string;
  email?: string;
  gstin?: string;
  billingStateCode?: string;
  address?: PosAddressInput;
  offersOptIn?: boolean;
}

export type PosSaleLineInput =
  | { variantId: string; quantity: number; unitPrice?: number; discount?: PosDiscount }
  | { custom: { title: string; unitPrice: number; gstRate?: number; hsn?: string }; quantity: number; discount?: PosDiscount };

export interface PosSaleRequest {
  /** Same id on a retry, so the server bills once. */
  clientSaleId: string;
  storeId?: string;
  /** Omitted for a walk-in. */
  customer?: PosSaleCustomerInput;
  lines: PosSaleLineInput[];
  cartDiscount?: PosDiscount;
  payments: PosPaymentInput[];
  note?: string;
  staffToken?: string;
  approvalToken?: string;
}

export interface PosSaleResult {
  orderId: string;
  orderName: string;
  total: number;
  payable: number;
  roundOff: number;
  paid: number;
  balanceDue: number;
  change: number;
  financialStatus: "PAID" | "PARTIALLY_PAID" | "PENDING";
  invoiceId: string | null;
  invoiceNumber: string | null;
  customerId: string | null;
  /** The public bill page, e.g. https://app.example/b/<token>. */
  billUrl: string;
  delivery: PosBillDelivery[];
}

export type PosBillDeliveryStatus = "sending" | "sent" | "delivered" | "read" | "not_sent" | "failed";

/** How the bill went out on one channel. `reason` is a plain sentence when it was not sent. */
export interface PosBillDelivery {
  channel: "whatsapp";
  status: PosBillDeliveryStatus;
  to: string | null;
  reason: string | null;
}

/** GET /pos/sales/:orderId/delivery and POST /pos/sales/:orderId/send-bill. */
export interface PosBillState {
  billUrl: string;
  delivery: PosBillDelivery[];
}

/** GET /pos/receipts/:orderId, and the customer's public bill at GET /public/bills/:token. */
export interface PosReceipt {
  width: 58 | 80;
  footer: string | null;
  store: { name: string; address: string | null; phone: string | null; gstin: string | null; logoUrl: string | null };
  order: { id: string; name: string; createdAt: string; staffName: string | null; storeName: string | null };
  invoice: { number: string; date: string; placeOfSupply: string | null; gstType: "INTRA" | "INTER" | null } | null;
  customer: { name: string | null; phone: string | null; gstin: string | null } | null;
  lines: Array<{
    title: string;
    variantTitle: string | null;
    hsn: string | null;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxableValue: number;
    gstRate: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
  }>;
  totals: { subtotal: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number; payable: number };
  gstSummary: Array<{ rate: number; taxable: number; cgst: number; sgst: number; igst: number }>;
  payments: Array<{ method: PosPaymentMethod; amount: number; tendered: number | null; change: number | null; reference: string | null }>;
  paid: number;
  balanceDue: number;
}
