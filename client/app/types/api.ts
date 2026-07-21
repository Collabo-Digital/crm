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
}

export interface VendorOrderLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
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

/** What `GET /orders/:id` returns to a VENDOR — their items only, no money/customer. */
export interface VendorOrderDetail {
  id: string;
  orderNumber: number;
  name: string;
  fulfillmentStatus: string;
  currency: string;
  createdAt: string;
  shipTo: VendorShipTo | null;
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

/** Payload for starting Shopify OAuth with merchant's custom app credentials. */
export interface ShopifyInstallRequest {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
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
  platform: string;
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
  variants: ProductVariant[];
  /** Set when the product has been pushed (or attempted to be pushed) to Shopify. */
  shopifySync: ProductShopifySync | null;
}

/** A product detail response with all variants, images, and CRM-managed fields. */
export interface ProductDetail extends Product {
  images: ProductImage[];
  bodyHtml?: string | null;
  hsnCode?: string | null;
  gstRate?: number | string | null;
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
  gstRate?: number;
  /** ISO 8601 string. When set on a DRAFT product in the future, the
   *  scheduler will flip it to ACTIVE on/after this date. */
  publishedAt?: string;
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
  option1?: string;
  option2?: string;
  option3?: string;
  position?: number;
  imageId?: string;
}

export type UpdateVariantRequest = Partial<Omit<CreateVariantRequest, "imageId">>;

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
  /** Present on detail responses; absent on list responses. */
  email?: string | null;
  /** Present on detail responses; absent on list responses. */
  phone?: string | null;
  /** Present on detail responses; absent on list responses. */
  shippingAddress?: Record<string, unknown> | null;
  /** Present on detail responses; absent on list responses. */
  billingAddress?: Record<string, unknown> | null;
  customer: OrderCustomer | null;
  channel: ChannelRef;
  itemCount: number;
  createdAt: string;
  /** Free-form metadata, includes `source`, `paymentMethod`, `shopifySync`, etc. */
  metadata?: Record<string, unknown> | null;
}

/** A line item within an order detail. */
export interface OrderLineItem {
  id: string;
  title: string;
  quantity: number;
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
}

/** A fulfillment record within an order detail. */
export interface OrderFulfillment {
  id: string;
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  createdAt: string;
}

/** A refund record within an order detail. */
export interface OrderRefund {
  id: string;
  amount: number;
  reason: string | null;
  createdAt: string;
}

/** A timeline event within an order detail. */
export interface OrderTimeline {
  id: string;
  message: string;
  createdAt: string;
}

/** Full order detail with line items, fulfillments, refunds, and timeline. */
export interface OrderDetail extends Order {
  lineItems: OrderLineItem[];
  fulfillments: OrderFulfillment[];
  refunds: OrderRefund[];
  timeline: OrderTimeline[];
}

/** Query parameters for the order list endpoint. */
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

/** Payload for creating an offline (in-store) order. */
export interface CreateOfflineOrderRequest {
  customer: OfflineCustomerInput;
  lineItems: OfflineLineItemInput[];
  sellerGstinId?: string;
  placeOfSupplyCode?: string;
  paymentMethod: OfflinePaymentMethod;
  note?: string;
  financialStatus?: FinancialStatus;
  fulfillmentStatus?: FulfillmentStatus;
  generateInvoice?: boolean;
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
export interface UpdateOrderRequest {
  tags?: string[];
  note?: string;
  email?: string;
  phone?: string;
  poNumber?: string;
  shippingAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  customAttributes?: { key: string; value: string }[];
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
}

/** Response from GET /organization/settings — every domain returned together. */
export interface OrganizationSettingsResponse {
  productSettings: ProductSettings;
  orderSettings: OrderSettings;
}

/** Patch payload for PATCH /organization/settings/products. */
export type UpdateProductSettingsRequest = Partial<ProductSettings>;

/** Patch payload for PATCH /organization/settings/orders. */
export type UpdateOrderSettingsRequest = Partial<OrderSettings>;

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
  shippingAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
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
  createdAt: string;
}

/** A customer activity log entry. */
export interface CustomerActivityLog {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Full customer detail with recent orders and activity history. */
export interface CustomerDetail extends Customer {
  orders: Order[];
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

/** A single metric with current/previous values and change percentage. */
export interface StatMetric {
  current: number;
  previous: number;
  change: {
    percentage: number;
    direction: ChangeDirection;
  };
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
export interface DashboardQueryParams {
  dateFrom?: string;
  dateTo?: string;
  channelId?: string;
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
  itemCount: number;
  createdAt: string;
}

/** Full dashboard overview response. */
export interface DashboardOverview {
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
export interface CreateGstinRequest {
  gstin: string;
  legalName: string;
  tradeName?: string;
  stateCode: string;
  stateName: string;
  address?: Record<string, unknown>;
  isDefault?: boolean;
}

/** Payload for updating a GSTIN registration. */
export interface UpdateGstinRequest {
  gstin?: string;
  legalName?: string;
  tradeName?: string;
  stateCode?: string;
  stateName?: string;
  address?: Record<string, unknown>;
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
  grandTotal: number;
  currency: string;
  status: InvoiceStatus;
  order: { name: string; orderNumber: number };
  createdAt: string;
}

/** Full invoice detail with line items. */
export interface InvoiceDetail extends Invoice {
  sellerGstin: string;
  sellerLegalName: string;
  sellerAddress: Record<string, unknown> | null;
  sellerStateCode: string;
  sellerStateName: string;
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
  sellerGstinId?: string;
}

/** Query parameters for the GST return summary endpoint. */
export interface GstReturnParams {
  financialYear: string;
  period: string;
  returnType?: "GSTR1" | "GSTR3B";
  sellerGstinId?: string;
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
    gstType: GstType;
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

/** HSN-wise summary in GSTR-1. */
export interface Gstr1HsnSummary {
  hsnCode: string;
  quantity: number;
  taxable: number;
  tax: number;
}

/** Full GSTR-1 return data. */
export interface GstReturnGstr1 {
  b2b: Gstr1B2bEntry[];
  b2cSummary: Gstr1B2cSummary[];
  hsnSummary: Gstr1HsnSummary[];
  totals: {
    totalTaxable: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
    totalTax: number;
    totalInvoices: number;
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

/** Full GSTR-3B return data. */
export interface GstReturnGstr3B {
  outwardSupplies: Gstr3bOutwardSupply[];
  interState: {
    invoiceCount: number;
    totalTaxable: number;
    totalIgst: number;
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
