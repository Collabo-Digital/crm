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

/** Available pricing plan tiers. Mirrors the Prisma `BillingPlan` enum. */
export type BillingPlan = "BASIC" | "GROWTH" | "ADVANCE";

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
  isActive: boolean;
  organization: Organization;
}

/** Possible roles a user can hold within an organization. */
export type UserRole = "OWNER" | "ADMIN" | "MANAGER" | "AGENT" | "VIEWER" | "VENDOR";

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
  verifyCode: string;
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
}

// ─── Team Invite Types ────────────────────────────────────────────────────

/** Payload for sending a team invitation. */
export interface SendInviteRequest {
  email: string;
  role: UserRole;
  /** Required when role is VENDOR: the Product.vendor value to scope them to. */
  vendorScope?: string;
}

/** A pending team invitation record. */
export interface OrgInvite {
  id: string;
  email: string;
  role: UserRole;
  status: "PENDING";
  token?: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

// ─── Invite Types (Auth-level) ────────────────────────────────────────────

/** Response when fetching invite details by token (pre-accept). */
export interface GetInviteResponse {
  email: string;
  role: UserRole;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  };
  userExists: boolean;
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
  organization: {
    id: string;
    name: string;
    slug: string;
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

/** Connection status of a channel. */
export type ChannelStatus = "CONNECTED" | "DISCONNECTED" | "ERROR" | "SYNCING";

/** Current synchronization status. */
export type SyncStatus = "IDLE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

/** A connected sales channel (e.g. Shopify store). */
export interface Channel {
  id: string;
  organizationId: string;
  name: string;
  platform: ChannelPlatform;
  status: ChannelStatus;
  isEnabled: boolean;
  externalStoreUrl: string | null;
  lastSyncedAt: string | null;
  syncStatus: SyncStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
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

/** Response containing the OAuth redirect URL. */
export interface OAuthInstallResponse {
  authUrl: string;
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
}

/** Response from POST /channels/whatsapp/callback after the channel is created. */
export interface WhatsAppCallbackResponse {
  channelId: string;
  redirectUrl: string;
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
export interface ProductVariantInput {
  /** Existing variant id when editing — `undefined` for a freshly-added row. */
  id?: string;
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
  Omit<CreateProductRequest, "variant">
> & {
  variant?: Partial<ProductVariantInput>;
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
  /**
   * Computed via `_count` on the LIST endpoint only — `undefined` on detail
   * responses despite the non-optional type. Fall back to `lineItems.length`.
   */
  itemCount: number;
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
  order: OrderDetail;
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
export const DASHBOARD_RANGES = ["30d", "6m", "12m"] as const;
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
  recentOrders: DashboardRecentOrder[];
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
   * remains uncredited. A partial credit is apportioned pro-rata across the
   * original lines, so each keeps its own GST rate.
   */
  amount?: number;
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
  /** CDNR when the buyer is registered, CDNUR when they are not. */
  section: "CDNR" | "CDNUR";
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

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  shopifyLocationId: string | null;
  address: Record<string, unknown> | null;
  /** GST registration this warehouse is an additional place of business of. */
  gstinId: string | null;
  /** Merchant's own confirmation that the APOB is declared on the GST portal. */
  apobDeclared: boolean;
  isDefault: boolean;
  isActive: boolean;
  locationCount: number;
  stockLineCount: number;
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
  sortBy?: "available" | "onHand" | "updatedAt" | "sku";
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

export interface CreateAdjustmentRequest {
  variantId: string;
  warehouseId?: string;
  bucket: StockBucket;
  delta?: number;
  setTo?: number;
  reason?: "adjustment" | "count" | "damage" | "found" | "correction";
  note?: string;
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
   * Barcode value shape (generate-barcodes only). "sku" copies the SKU
   * verbatim (default); "short" mints a 6-digit numeric code that fits small
   * and jewellery label stock, which an 18-character SKU cannot.
   */
  format?: "sku" | "short";
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
  address?: Record<string, unknown>;
  gstinId?: string | null;
  apobDeclared?: boolean;
  isDefault?: boolean;
}

export interface UpdateWarehouseRequest {
  name?: string;
  address?: Record<string, unknown>;
  /** null unlinks the registration; omit to leave it unchanged. */
  gstinId?: string | null;
  apobDeclared?: boolean;
  isDefault?: boolean;
  isActive?: boolean;
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

// ─── Conversation Types ──────────────────────────────────────────────────────

/**
 * The subset of ChannelPlatform that can carry a two-way conversation.
 *
 * Deliberately a subset of the real enum rather than a parallel vocabulary, so
 * ChannelBadge and CHANNEL_ICON (components/app/channel-badge.tsx:15) work
 * unmodified. The placeholder set this replaces (email|sms|whatsapp|chat)
 * matched nothing the backend can support.
 */
export type ConversationChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";

export type ConversationStatus = "OPEN" | "SNOOZED" | "RESOLVED";

/** Left-rail buckets. Server-computed — the client never re-derives the rules. */
export type ConversationFolder =
  | "INBOX"
  | "UNASSIGNED"
  | "MINE"
  | "SNOOZED"
  | "RESOLVED";

export type MessageDirection = "INBOUND" | "OUTBOUND";

/** Outbound lifecycle. QUEUED is the optimistic state; FAILED is terminal-until-retry. */
export type MessageStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";

export type MessageKind =
  | "TEXT"
  | "IMAGE"
  | "TEMPLATE"
  | "CATALOG"
  | "ORDER_CARD"
  | "SYSTEM";

/** An agent who can be assigned a conversation. `id` joins to OrgMember.user.id. */
export interface Assignee {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * The WhatsApp 24h customer-service window.
 *
 * Carries an ABSOLUTE expiry, never a remaining-milliseconds number: a duration
 * is stale the instant it leaves the server, and a client that decrements it
 * drifts on every dropped frame and freezes outright when the laptop sleeps.
 * The client recomputes from `expiresAt` on each tick.
 *
 * `isOpen` is the server's own view at response time — advisory only.
 */
export interface SessionWindow {
  openedAt: string;
  /** Null on channels that have no window concept. */
  expiresAt: string | null;
  isOpen: boolean;
}

/**
 * A conversation tag.
 *
 * The server sends a semantic TONE, never a colour: a hex on the wire would
 * land in a component (which DESIGN.md rule 1 forbids) and would not flip for
 * dark mode. The client maps tone → token classes in exactly one place.
 */
export interface ConversationTag {
  id: string;
  label: string;
  tone: "brand" | "info" | "success" | "warning" | "danger" | "neutral";
}

/** The person on the other end. `customerId` is null for an unmatched number. */
export interface ConversationCustomer {
  customerId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface MessageAttachment {
  id: string;
  type: "IMAGE" | "FILE" | "AUDIO";
  url: string;
  name: string | null;
}

/**
 * A product shared into a conversation.
 *
 * Denormalised on purpose — title, price and image are COPIED at send time
 * rather than resolved from the catalogue on read. A shared product is a
 * statement about what was offered at that moment; re-resolving it later would
 * silently rewrite history when the price changes, and would blank the card
 * entirely once the product is archived or deleted.
 */
export interface MessageProduct {
  productId: string;
  /** Null when shared without pinning a variant. */
  variantId: string | null;
  title: string;
  /** e.g. "L / Olive". Null when no variant was pinned. */
  variantTitle: string | null;
  sku: string | null;
  /** The exact price when a variant is pinned; null when it is not. */
  price: number | null;
  /** The product's spread, used when no variant is pinned. */
  priceRange: { min: number; max: number } | null;
  currency: string;
  imageUrl: string | null;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  /**
   * Echoed back from SendMessageRequest so an optimistic bubble is reconciled
   * rather than duplicated. Null on anything we did not send.
   */
  clientId: string | null;
  direction: MessageDirection;
  kind: MessageKind;
  body: string;
  attachments: MessageAttachment[];
  /**
   * Products shared in this message. Always an array — an optional field would
   * force a `?? []` at every render site for no gain.
   */
  products: MessageProduct[];
  /** Meaningful for OUTBOUND only. */
  status: MessageStatus;
  /** Null for inbound and for automation. */
  author: Assignee | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  failureReason: string | null;
}

/**
 * An internal note.
 *
 * Its own entity, deliberately NOT a MessageKind: a note has no channel, no
 * delivery status, and must never be sendable to the customer. Folding it into
 * ConversationMessage makes "accidentally sent the internal note" a one-line
 * bug. The thread merges the two streams by createdAt on the client.
 */
export interface InternalNote {
  id: string;
  conversationId: string;
  body: string;
  author: Assignee;
  createdAt: string;
}

/** List-row projection of a conversation. */
export interface Conversation {
  id: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  folders: ConversationFolder[];
  customer: ConversationCustomer;
  assignee: Assignee | null;
  tags: ConversationTag[];
  /** Denormalised so a 50-row list is one request, not 51. */
  lastMessage: {
    preview: string;
    direction: MessageDirection;
    createdAt: string;
  } | null;
  unreadCount: number;
  snoozedUntil: string | null;
  sessionWindow: SessionWindow | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
  notes: InternalNote[];
  insights: ConversationInsights;
}

/** Commerce snapshot for the right rail. */
export interface ConversationInsights {
  currency: string;
  lifetimeSpend: number;
  ordersCount: number;
  lastOrder: ConversationLastOrder | null;
}

export interface ConversationLastOrder {
  /** Real Order id — the panel links to /orders/:id. */
  id: string;
  name: string;
  /** Reuses the existing enums so lib/order-status.ts renders the badge. */
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  totalPrice: number;
  placedAt: string;
  items: {
    title: string;
    variantTitle: string | null;
    quantity: number;
    price: number;
    imageUrl: string | null;
  }[];
  shipping: {
    carrier: string | null;
    trackingNumber: string | null;
    etaLabel: string | null;
  } | null;
}

// ── Conversation requests / responses ──

export type ConversationSort = "NEWEST" | "OLDEST" | "UNREAD_FIRST";

export interface ConversationListParams {
  folder?: ConversationFolder;
  tagId?: string;
  search?: string;
  sort?: ConversationSort;
  page?: number;
  limit?: number;
}

/**
 * Folder and tag counts, on their own endpoint.
 *
 * NOT part of the list response: the rail must read "Inbox 12" while you are
 * looking at Unassigned. Counts riding on the list would be scoped to the
 * active filter and every number would collapse to the visible row count.
 */
export interface ConversationInboxSummary {
  folders: { folder: ConversationFolder; count: number }[];
  tags: (ConversationTag & { count: number })[];
}

/** `assigneeId: null` unassigns. */
export interface AssignConversationRequest {
  assigneeId: string | null;
}

export interface SnoozeConversationRequest {
  /** ISO timestamp. */
  until: string;
}

/** Whole array, matching the UpdateCustomerRequest.tags convention. */
export interface UpdateConversationTagsRequest {
  tagIds: string[];
}

export interface SendMessageRequest {
  /** May be empty when `products` is not — a product card is a message on its own. */
  body: string;
  /** Defaults to TEXT; send CATALOG when products are attached. */
  kind?: MessageKind;
  /** Required — see ConversationMessage.clientId. */
  clientId: string;
  products?: MessageProduct[];
}

export interface AddNoteRequest {
  body: string;
}

export interface MarkReadRequest {
  upToMessageId?: string;
}

export interface MarkReadResponse {
  conversationId: string;
  unreadCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Logistics Types ───
//
// There is no logistics module on the server: no Shipment table, no courier
// integration, no AWB anywhere. Everything below describes the API this module
// WILL have, and is currently served by `lib/mock/logistics-store.ts` through
// `services/logistics.service.ts` — the same arrangement the Conversation
// section uses. See that service's header for the swap contract.
//
// The one piece of real shipment data in the app today is the tracking triple
// on `OrderFulfillment` (trackingNumber / trackingUrl / trackingCompany).
// `Shipment.fulfillmentId` is where the two will meet.
// ─────────────────────────────────────────────────────────────────────────────

/** Prepaid vs cash-on-delivery. Drives COD amount, courier eligibility and remittance. */
export type PaymentMode = "PREPAID" | "COD";

/**
 * The forward-journey states, in the order they occur.
 *
 * `DELAYED` is a stored state rather than a derived one: a courier can report a
 * delay while the parcel is still in transit, and operators filter on it
 * directly. `NDR` likewise — an undelivered attempt is its own state, not a flag
 * on OUT_FOR_DELIVERY, because the shipment stops moving until someone acts.
 */
export type ShipmentStatus =
  | "DRAFT"
  | "COURIER_ASSIGNED"
  | "AWB_ASSIGNED"
  | "READY_TO_SHIP"
  | "PICKUP_SCHEDULED"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "DELAYED"
  | "NDR"
  | "RTO_INITIATED"
  | "RTO_IN_TRANSIT"
  | "RTO_DELIVERED"
  | "CANCELLED";

/**
 * Coarse buckets for the shipment list's tab strip. Fifteen statuses will not
 * fit a segmented control, so the tabs filter by group and the filter drawer
 * offers the full status list as a multi-select.
 */
export type ShipmentStatusGroup =
  | "ALL"
  | "READY"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "EXCEPTION";

export type ShipmentServiceType = "SURFACE" | "EXPRESS" | "AIR" | "SAME_DAY";

/** What an order in the "Orders to Ship" queue is waiting on. */
export type ShippableOrderStatus =
  | "UNFULFILLED"
  | "READY_TO_PROCESS"
  | "ON_HOLD"
  | "EXCEPTION"
  | "PARTIALLY_SHIPPED";

/** A postal address as logistics needs it — flattened, always with a pincode. */
export interface ShippingAddress {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  /** Set when a courier or the operator has corrected the original address. */
  isVerified?: boolean;
}

/** One physical box. A shipment can hold several. */
export interface ShipmentPackage {
  id: string;
  /** Free-form label the operator picked — "Bag", "Box", a custom preset name. */
  type: string;
  /** Centimetres. */
  length: number;
  width: number;
  height: number;
  /** Kilograms, as weighed. */
  weight: number;
  /** How many identical boxes this row represents. */
  count: number;
}

export interface ShipmentLineItem {
  id: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle?: string;
  sku: string;
  quantity: number;
  price: number;
  imageUrl?: string | null;
}

/** One tracking scan or internal state change. Powers the vertical timeline. */
export interface ShipmentEvent {
  id: string;
  status: ShipmentStatus;
  label: string;
  /** Courier remark, verbatim. Absent for internal (CRM-generated) events. */
  remark?: string;
  location?: string;
  occurredAt: string;
  /** COURIER events came off a scan; SYSTEM ones we generated. */
  source: "COURIER" | "SYSTEM" | "USER";
  /** Renders the node in danger and offers an inline action. */
  isException?: boolean;
}

/** List-row shape. */
export interface Shipment {
  id: string;
  /** Human-facing id, e.g. "SHP-10452". */
  reference: string;
  orderId: string;
  /** Shopify order name, e.g. "#10452". */
  orderName: string;
  /** Links back to the real OrderFulfillment once a backend exists. */
  fulfillmentId: string | null;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  courierId: string | null;
  courierName: string | null;
  serviceType: ShipmentServiceType | null;
  /** Null until AWB generation succeeds. */
  awb: string | null;
  trackingUrl: string | null;
  status: ShipmentStatus;
  paymentMode: PaymentMode;
  /** Only meaningful when paymentMode is COD. */
  codAmount: number;
  orderValue: number;
  currency: string;
  packageCount: number;
  /** Kilograms — the billable figure, max(actual, volumetric). */
  chargeableWeight: number;
  shippingCost: number;
  pickupLocationId: string;
  pickupLocationName: string;
  destinationCity: string;
  destinationState: string;
  destinationPincode: string;
  channel: ChannelRef | null;
  createdAt: string;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  /** Set when the courier promise date has passed with no delivery scan. */
  isDelayed: boolean;
  ndrCaseId: string | null;
  rtoCaseId: string | null;
  returnRequestId: string | null;
}

export interface ShipmentDetail extends Shipment {
  origin: ShippingAddress;
  destination: ShippingAddress;
  packages: ShipmentPackage[];
  lineItems: ShipmentLineItem[];
  events: ShipmentEvent[];
  manifestId: string | null;
  manifestReference: string | null;
  pickupRequestId: string | null;
  /** Freight + COD fee + fuel surcharge, so the cost card can break it down. */
  costBreakdown: { label: string; amount: number }[];
  /** Present once a label has been generated. */
  labelUrl: string | null;
  customerTags: string[];
  notes: string | null;
}

export interface ShipmentListParams {
  page?: number;
  limit?: number;
  search?: string;
  group?: ShipmentStatusGroup;
  status?: ShipmentStatus[];
  courierId?: string[];
  paymentMode?: PaymentMode;
  pickupLocationId?: string[];
  channelId?: string;
  destinationState?: string[];
  dateFrom?: string;
  dateTo?: string;
  /** Convenience flags the filter drawer exposes as checkboxes. */
  delayedOnly?: boolean;
  ndrOnly?: boolean;
  rtoOnly?: boolean;
}

/** A Shopify order sitting in the fulfillment queue. */
export interface ShippableOrder {
  id: string;
  orderName: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  destinationCity: string;
  destinationState: string;
  destinationPincode: string;
  itemCount: number;
  items: ShipmentLineItem[];
  orderValue: number;
  currency: string;
  paymentMode: PaymentMode;
  isPaid: boolean;
  pickupLocationId: string | null;
  pickupLocationName: string | null;
  channel: ChannelRef | null;
  createdAt: string;
  /** When this order breaches its ship-by promise. Drives the SLA column. */
  shipBy: string;
  status: ShippableOrderStatus;
  /** Why it is on hold or in exception — shown as the row sub-label. */
  holdReason: string | null;
}

export interface ShippableOrderListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: ShippableOrderStatus | "ALL";
  pickupLocationId?: string[];
  paymentMode?: PaymentMode;
  channelId?: string;
  sla?: "breached" | "at-risk" | "ok";
}

export interface CourierPartner {
  id: string;
  name: string;
  /** Two-letter mark used as the avatar fallback — no logo assets exist. */
  initials: string;
  isActive: boolean;
  supportsCod: boolean;
  serviceTypes: ShipmentServiceType[];
  /** Rough coverage figure for the setup screen. */
  pincodesServed: number;
  /** Average turnaround in days, one decimal. */
  avgTat: number;
  deliveryRate: number;
  ndrRate: number;
  rtoRate: number;
  avgCost: number;
  /** Out of 5. */
  rating: number;
  shipmentCount: number;
  /** Manual ordering used by the shipping rules fallback chain. */
  priority: number;
}

export interface CourierZone {
  zone: string;
  description: string;
  tat: string;
  baseRate: number;
  additionalRate: number;
}

/** One courier's offer for a specific shipment. */
export interface CourierQuote {
  courierId: string;
  courierName: string;
  initials: string;
  serviceType: ShipmentServiceType;
  /** Total the merchant pays. */
  cost: number;
  breakdown: { label: string; amount: number }[];
  estimatedPickupAt: string;
  estimatedDeliveryAt: string;
  supportsCod: boolean;
  rating: number;
  deliveryRate: number;
  rtoRate: number;
  /** False renders the card greyed with unavailableReason shown, not hidden. */
  isServiceable: boolean;
  unavailableReason?: string;
  /** Why the recommender picked this one. Shown on the ribbon. */
  recommendationReason?: string;
}

/**
 * A warehouse in its logistics role. Mirrors the real Warehouse record rather
 * than replacing it — warehouse CRUD stays on the Inventory screens, and this
 * page links there instead of offering a second place to edit the same row.
 */
export interface PickupLocation {
  id: string;
  warehouseId: string;
  name: string;
  code: string;
  address: ShippingAddress;
  isDefault: boolean;
  isActive: boolean;
  contactName: string;
  contactPhone: string;
  /** Local time, HH:mm — after this, pickups roll to the next day. */
  cutoffTime: string;
  operatingHours: string;
  /** Parcels this location can hand over per day. */
  dailyCapacity: number;
  usedCapacity: number;
  serviceablePincodes: number;
  skuCount: number;
  ordersAwaiting: number;
  shipmentsProcessed30d: number;
}

/** Counts for the section rail and the overview pipeline strip. */
export interface LogisticsSummary {
  ordersToShip: number;
  readyToShip: number;
  pickupPending: number;
  inTransit: number;
  outForDelivery: number;
  deliveredToday: number;
  delayed: number;
}

export interface CourierPerformanceRow {
  courierId: string;
  courierName: string;
  initials: string;
  shipments: number;
  deliveryRate: number;
  ndrRate: number;
  rtoRate: number;
  avgTat: number;
  avgCost: number;
}

export interface LogisticsOverview {
  summary: LogisticsSummary;
  courierPerformance: CourierPerformanceRow[];
}

// ─── Logistics write payloads ───

export interface CreateShipmentRequest {
  orderIds: string[];
  pickupLocationId: string;
  packages: Omit<ShipmentPackage, "id">[];
  paymentMode: PaymentMode;
  codAmount?: number;
  courierId: string;
  serviceType: ShipmentServiceType;
  /** Runs AWB + label generation as part of the create call. */
  generateAwb?: boolean;
}

export interface CreateShipmentResult {
  shipments: Shipment[];
  /** Per-order outcome, so bulk mode can report partial success. */
  results: {
    orderId: string;
    orderName: string;
    shipmentId: string | null;
    error: string | null;
  }[];
}

export interface CourierQuoteRequest {
  orderIds: string[];
  pickupLocationId: string;
  packages: Omit<ShipmentPackage, "id">[];
  paymentMode: PaymentMode;
  codAmount?: number;
}

export interface BulkOrderActionRequest {
  orderIds: string[];
  action: "HOLD" | "RELEASE_HOLD" | "ASSIGN_LOCATION";
  pickupLocationId?: string;
  reason?: string;
}

export interface GenerateAwbResult {
  shipmentId: string;
  awb: string;
  trackingUrl: string;
  labelUrl: string;
}

// ─── Logistics: Returns & RTO ───

/** Whether a parcel is coming back because the customer sent it or because it never landed. */
export type ReturnKind = "CUSTOMER_RETURN" | "RTO";

export type ReturnStage =
  | "REQUESTED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "RECEIVED"
  | "REFUNDED"
  | "EXCEPTION";

export interface ReturnRecord {
  id: string;
  orderId: string;
  orderName: string;
  customerName: string;
  reason: string;
  kind: ReturnKind;
  stage: ReturnStage;
  refundAmount: number;
  currency: string;
  /** The one thing to do next, e.g. "Issue refund". */
  actionLabel: string;
  requestedAt: string;
}

/** One bar in the "why parcels come back" panel. */
export interface ReturnReasonShare {
  label: string;
  /** 0-100. */
  percent: number;
  tone: "brand" | "danger" | "warning" | "neutral" | "info";
}

export interface ReturnsOverview {
  openReturns: number;
  rtoInTransit: number;
  rtoRate: number;
  refundsPending: number;
  currency: string;
  returns: ReturnRecord[];
  reasons: ReturnReasonShare[];
  /** Total the reason breakdown is drawn from. */
  reasonSampleSize: number;
  insight: string;
}

// ─── Logistics: Carriers & rates ───

export type CarrierAccountState = "CONNECTED" | "RATE_LIMITED" | "NOT_LINKED";

export interface CarrierAccount {
  id: string;
  name: string;
  initials: string;
  /** e.g. "acct 4820", or "not linked". */
  accountLabel: string;
  state: CarrierAccountState;
  onTimeRate: number;
  avgCost: number;
  volume30d: number;
  /** e.g. "Surface · Express · COD". */
  services: string;
}

export interface RateCardRow {
  id: string;
  service: string;
  carrierName: string;
  base: number;
  additional: number;
  /** Free text — carriers quote COD as "₹28 or 1.5%". */
  codFee: string;
  rtoCharge: string;
  transit: string;
}

export interface CarrierRule {
  id: string;
  position: number;
  when: string;
  then: string;
  state: "ACTIVE" | "FALLBACK";
}

export interface CarriersOverview {
  carriers: CarrierAccount[];
  rateCard: RateCardRow[];
  rules: CarrierRule[];
  currency: string;
}

// ─── Logistics: Zones & delivery areas ───

export interface ZoneRate {
  id: string;
  name: string;
  /** e.g. "Orders over 999". */
  condition: string;
  price: number;
}

export interface DeliveryZone {
  id: string;
  name: string;
  tone: "brand" | "success" | "neutral" | "muted";
  coverage: string;
  transit: string;
  rates: ZoneRate[];
}

export interface ZoneShare {
  zoneId: string;
  name: string;
  tone: DeliveryZone["tone"];
  orders: number;
  /** 0-100. */
  percent: number;
}

export interface NonServiceablePincode {
  pincode: string;
  place: string;
  note: string;
  blockedLabel: string;
}

export interface ZonesOverview {
  zones: DeliveryZone[];
  share: ZoneShare[];
  nonServiceable: NonServiceablePincode[];
  currency: string;
}

// ─── Logistics: Delivery analytics ───

export interface DeliveryAnalytics {
  onTimeRate: number;
  avgTransitDays: number;
  spend: number;
  costPerParcel: number;
  currency: string;
  /** One entry a day, oldest first. */
  daily: { date: string; onTime: number; late: number }[];
  carrierScores: { carrierId: string; name: string; onTimePct: number; cost: number }[];
  slowestRoutes: { route: string; days: number; volume: number }[];
  spendBreakdown: {
    label: string;
    amount: number;
    percent: number;
    tone: "brand" | "info" | "warning" | "neutral";
  }[];
  carrierInsight: string;
}
