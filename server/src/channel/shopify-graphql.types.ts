// Hand-written types for the Shopify Admin GraphQL queries used by the CRM.
// We avoid codegen here so adding/changing a query doesn't require regenerating
// a large schema file; expand this file as new queries land in later phases.

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface MoneyBag {
  shopMoney: MoneyV2;
  presentmentMoney?: MoneyV2;
}

export interface MailingAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  country: string | null;
  countryCodeV2: string | null;
  zip: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  phone: string | null;
  company: string | null;
}

// ─── Orders list query ───────────────────────────────────────────────────────

export type OrderSortKey =
  | 'PROCESSED_AT'
  | 'UPDATED_AT'
  | 'CREATED_AT'
  | 'ORDER_NUMBER'
  | 'TOTAL_PRICE';

export interface OrdersListVariables {
  first: number;
  after?: string | null;
  query?: string | null;
  sortKey?: OrderSortKey;
  reverse?: boolean;
}

export interface OrderCustomerNode {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface TaxLineNode {
  title: string | null;
  /** Fractional rate as Shopify reports it — 0.18 for 18%, not 18. */
  rate: number | null;
  priceSet: MoneyBag;
}

export interface OrderLineItemNode {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /**
   * Units on this line NOT yet fulfilled. The only per-line shipping signal the
   * GraphQL order query exposes — there is no flat `fulfillment_status` — and a
   * plain scalar, so unlike a nested `fulfillmentLineItems` connection it adds
   * nothing meaningful to the query's calculated cost. Without it a Shopify
   * order fulfilled in the admin arrived with every line reading unfulfilled
   * and no shipped count, so the whole order showed as outstanding and offered
   * no fulfilment actions at all.
   */
  unfulfilledQuantity: number;
  originalUnitPriceSet: MoneyBag;
  totalDiscountSet: MoneyBag;
  requiresShipping: boolean;
  taxable: boolean;
  /** What Shopify actually charged in tax on this line. The CRM computes its
   *  own figure for the invoice; this is stored to reconcile the two. */
  taxLines?: TaxLineNode[];
  variant: { id: string; product: { id: string } | null } | null;
  customAttributes: Array<{ key: string; value: string | null }>;
}

export interface OrderFulfillmentNode {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
}

export interface OrderRefundLineItemNode {
  id: string;
  quantity: number;
  restockType: string | null;
  /**
   * Tax actually returned on this line.
   *
   * A MoneyBag, NOT a `taxLines` connection: `refundLineItems(first: 50)` is
   * already nested inside `refunds(first: 50)`, and adding a third connection
   * level would push this query past the cost ceiling it is already close to.
   * A scalar money field costs nothing extra.
   */
  totalTaxSet: MoneyBag;
  lineItem: { id: string };
}

export interface OrderRefundNode {
  id: string;
  note: string | null;
  createdAt: string;
  totalRefundedSet: MoneyBag;
  refundLineItems: { nodes: OrderRefundLineItemNode[] };
}

export interface OrderNode {
  id: string;
  name: string;
  number: number;
  email: string | null;
  phone: string | null;
  note: string | null;
  tags: string[];
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  cancelReason: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  /** Set by our own pushOrder so a pushed offline order can be re-adopted
   *  instead of re-imported as a duplicate. */
  sourceIdentifier: string | null;
  sourceName: string | null;
  createdAt: string;
  updatedAt: string;
  currencyCode: string;
  currentSubtotalPriceSet: MoneyBag;
  totalPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  /** True when line prices already contain tax. The CRM treats prices as
   *  tax-EXCLUSIVE, so this being true is a systematic reconciliation
   *  difference rather than a configuration drift. */
  taxesIncluded?: boolean;
  shippingLine?: { title: string | null; taxLines: TaxLineNode[] } | null;
  totalDiscountsSet: MoneyBag;
  totalShippingPriceSet: MoneyBag;
  shippingAddress: MailingAddress | null;
  billingAddress: MailingAddress | null;
  customer: OrderCustomerNode | null;
  lineItems: { pageInfo?: PageInfo; nodes: OrderLineItemNode[] };
  fulfillments: OrderFulfillmentNode[];
  /** Order-level refund total. A cheap scalar standing in for the refunds
   *  connection, which ORDERS_LIST_QUERY no longer selects -- it tells
   *  `drainRefunds` whether this order is worth a follow-up call at all. */
  totalRefundedSet: MoneyBag;
  /** Empty as returned by ORDERS_LIST_QUERY; populated by `drainRefunds` for
   *  the orders that actually have refunds. */
  refunds: OrderRefundNode[];
}

/**
 * Fetch a further page of one order's line items.
 *
 * ORDERS_LIST_QUERY takes only the first 100. Without draining, an order with
 * more items imports a subset SILENTLY: the order total comes from Shopify and
 * stays correct, so nothing looks wrong, but the GST invoice (built from the
 * line items) understates the sale and vendors whose items fall in the missing
 * tail never see the order at all.
 */
export const ORDER_LINE_ITEMS_PAGE_QUERY = /* GraphQL */ `
  query OrderLineItemsPage($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      id
      lineItems(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          unfulfilledQuantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          totalDiscountSet { shopMoney { amount currencyCode } }
          requiresShipping
          taxable
          taxLines { title rate priceSet { shopMoney { amount currencyCode } } }
          variant {
            id
            product { id }
          }
          customAttributes { key value }
        }
      }
    }
  }
`;

export interface OrderLineItemsPageResponse {
  order: {
    id: string;
    lineItems: { pageInfo: PageInfo; nodes: OrderLineItemNode[] };
  } | null;
}

export interface OrderLineItemsPageVariables {
  id: string;
  first: number;
  after?: string | null;
}

export interface OrdersListResponse {
  orders: {
    pageInfo: PageInfo;
    nodes: OrderNode[];
  };
}

// The query asks for everything `upsertOrder` in shopify-sync.service.ts needs.
// `fulfillments(first: ...)` is a plain list (capped); `refundLineItems` is a
// connection. Keep field selection minimal — every byte counts against the
// per-query cost budget.
export const ORDERS_LIST_QUERY = /* GraphQL */ `
  query OrdersList(
    $first: Int!
    $after: String
    $query: String
    $sortKey: OrderSortKeys
    $reverse: Boolean
  ) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        number
        email
        phone
        note
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        cancelReason
        cancelledAt
        closedAt
        sourceIdentifier
        sourceName
        createdAt
        updatedAt
        currencyCode
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        taxesIncluded
        shippingLine { title taxLines { title rate priceSet { shopMoney { amount currencyCode } } } }
        totalDiscountsSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
        shippingAddress {
          address1 address2 city province provinceCode country countryCodeV2
          zip firstName lastName name phone company
        }
        billingAddress {
          address1 address2 city province provinceCode country countryCodeV2
          zip firstName lastName name phone company
        }
        customer {
          id email firstName lastName
        }
        lineItems(first: 25) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            unfulfilledQuantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            totalDiscountSet { shopMoney { amount currencyCode } }
            requiresShipping
            taxable
            taxLines { title rate priceSet { shopMoney { amount currencyCode } } }
            variant {
              id
              product { id }
            }
            customAttributes { key value }
          }
        }
        fulfillments(first: 50) {
          id
          status
          createdAt
          updatedAt
          trackingInfo { number url company }
        }
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

/**
 * Fetch one order's refunds.
 *
 * WHY this is not in ORDERS_LIST_QUERY: `refunds(first: 50)` nesting
 * `refundLineItems(first: 50)` requests ~2,500 nodes PER ORDER, and Shopify
 * prices a query before running it against a 1,000-point ceiling. Multiplied by
 * the orders page size, that put the list query structurally over the limit --
 * which is why orders failed to sync while products (no nested connections)
 * were fine.
 *
 * Refunds are rare, so pulling them per-order costs almost nothing in practice:
 * `drainRefunds` only calls this when the order's financial status or
 * `totalRefundedSet` says there is something to fetch.
 */
export const ORDER_REFUNDS_QUERY = /* GraphQL */ `
  query OrderRefunds($id: ID!) {
    order(id: $id) {
      id
      refunds(first: 50) {
        id
        note
        createdAt
        totalRefundedSet { shopMoney { amount currencyCode } }
        refundLineItems(first: 50) {
          nodes {
            id
            quantity
            restockType
            totalTaxSet { shopMoney { amount currencyCode } }
            lineItem { id }
          }
        }
      }
    }
  }
`;

export interface OrderRefundsResponse {
  order: { id: string; refunds: OrderRefundNode[] } | null;
}

export interface OrderRefundsVariables {
  id: string;
}

// ─── Common shapes for Phase 1 mutations ────────────────────────────────────

/**
 * Standard Shopify userError shape. Most mutations return this; some
 * specialised ones (e.g. orderCancel) return a typed variant — handle both.
 */
export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface MailingAddressInput {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  countryCode?: string | null;
  zip?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  company?: string | null;
}

export interface AttributeInput {
  key: string;
  value: string;
}

// ─── orderUpdate ────────────────────────────────────────────────────────────

export interface OrderUpdateInput {
  id: string;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  poNumber?: string | null;
  tags?: string[];
  customAttributes?: AttributeInput[];
  shippingAddress?: MailingAddressInput;
}

export interface OrderUpdateVariables {
  input: OrderUpdateInput;
}

export interface OrderUpdateResponse {
  orderUpdate: {
    order: { id: string; updatedAt: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id updatedAt }
      userErrors { field message }
    }
  }
`;

// ─── orderCancel ────────────────────────────────────────────────────────────
// Async on Shopify's side — returns a Job, not the order. We update the local
// row optimistically and let the `orders/cancelled` webhook reconcile.

export type ShopifyOrderCancelReason =
  | 'CUSTOMER'
  | 'FRAUD'
  | 'INVENTORY'
  | 'DECLINED'
  | 'OTHER'
  | 'STAFF';

export interface OrderCancelVariables {
  orderId: string;
  reason: ShopifyOrderCancelReason;
  refund: boolean;
  restock: boolean;
  notifyCustomer?: boolean | null;
  staffNote?: string | null;
}

export interface OrderCancelResponse {
  orderCancel: {
    job: { id: string; done: boolean } | null;
    orderCancelUserErrors: ShopifyUserError[];
  };
}

export const ORDER_CANCEL_MUTATION = /* GraphQL */ `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $refund: Boolean!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: $refund
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

// ─── orderClose / orderOpen ─────────────────────────────────────────────────

export interface OrderCloseOrOpenVariables {
  input: { id: string };
}

export interface OrderCloseResponse {
  orderClose: {
    order: { id: string; closed: boolean; closedAt: string | null } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface OrderOpenResponse {
  orderOpen: {
    order: { id: string; closed: boolean; closedAt: string | null } | null;
    userErrors: ShopifyUserError[];
  };
}

export const ORDER_CLOSE_MUTATION = /* GraphQL */ `
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id closed closedAt }
      userErrors { field message }
    }
  }
`;

export const ORDER_OPEN_MUTATION = /* GraphQL */ `
  mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id closed closedAt }
      userErrors { field message }
    }
  }
`;

// ─── orderMarkAsPaid ────────────────────────────────────────────────────────

export interface OrderMarkAsPaidVariables {
  input: { id: string };
}

export interface OrderMarkAsPaidResponse {
  orderMarkAsPaid: {
    order: { id: string; displayFinancialStatus: string | null } | null;
    userErrors: ShopifyUserError[];
  };
}

export const ORDER_MARK_AS_PAID_MUTATION = /* GraphQL */ `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

// ─── orderCapture ───────────────────────────────────────────────────────────
// Needs the parentTransactionId of the authorize transaction. We expose a
// small read query to fetch it before calling the capture mutation.

export interface OrderCapturableTransactionsVariables {
  id: string;
}

export interface OrderCapturableTransactionNode {
  id: string;
  kind: string;
  status: string;
  amountSet: MoneyBag;
}

export interface OrderCapturableTransactionsResponse {
  order: {
    id: string;
    transactions: OrderCapturableTransactionNode[];
  } | null;
}

export const ORDER_CAPTURABLE_TRANSACTIONS_QUERY = /* GraphQL */ `
  query OrderCapturableTransactions($id: ID!) {
    order(id: $id) {
      id
      transactions(first: 10, capturable: true) {
        id
        kind
        status
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

export interface OrderCaptureVariables {
  input: {
    id: string;
    parentTransactionId: string;
    amount: string;
    currency?: string | null;
    finalCapture?: boolean | null;
  };
}

export interface OrderCaptureResponse {
  orderCapture: {
    transaction: {
      id: string;
      kind: string;
      status: string;
      amountSet: MoneyBag;
    } | null;
    userErrors: ShopifyUserError[];
  };
}

export const ORDER_CAPTURE_MUTATION = /* GraphQL */ `
  mutation OrderCapture($input: OrderCaptureInput!) {
    orderCapture(input: $input) {
      transaction {
        id
        kind
        status
        amountSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// ─── Phase 2: Fulfillment & tracking ────────────────────────────────────────

/**
 * Fetch the OPEN fulfillment orders for a Shopify order — the natural unit
 * that `fulfillmentCreate` works on. Each FO carries its assigned location and
 * the line items that are still fulfillable from there. Closed/cancelled FOs
 * are not returned so the UI doesn't show stale options.
 */
export interface FulfillmentOrderLineItemNode {
  id: string;
  remainingQuantity: number;
  totalQuantity: number;
  lineItem: {
    id: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
  };
}

/**
 * Shopify's FulfillmentOrderStatus, in full.
 *
 * Spelled out rather than left as `string` so an unhandled status is a compile
 * error. It was `string`, and the code only ever named OPEN / IN_PROGRESS /
 * ON_HOLD — the ones it wanted to *repair* — while implicitly treating every
 * other value as fulfillable. `CLOSED` appeared nowhere, which is how a closed
 * fulfilment order ended up inside a `fulfillmentCreate` payload.
 *
 * `(string & {})` keeps an unrecognised future value assignable (Shopify can add
 * one without breaking the build) while still autocompleting the known set.
 */
export type FulfillmentOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'SCHEDULED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'INCOMPLETE'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

export interface FulfillmentOrderNode {
  id: string;
  status: FulfillmentOrderStatus;
  requestStatus: string;
  assignedLocation: {
    name: string | null;
    location: { id: string } | null;
  } | null;
  lineItems: { nodes: FulfillmentOrderLineItemNode[] };
}

export interface OrderFulfillmentOrdersResponse {
  order: {
    id: string;
    fulfillmentOrders: { nodes: FulfillmentOrderNode[] };
  } | null;
}

export const ORDER_FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 25, query: "status:OPEN OR status:IN_PROGRESS") {
        nodes {
          id
          status
          requestStatus
          assignedLocation {
            name
            location { id }
          }
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              totalQuantity
              lineItem {
                id
                title
                variantTitle
                sku
              }
            }
          }
        }
      }
    }
  }
`;

// ─── Fulfilment locations only ──────────────────────────────────────────────
// Answers one question — which location(s) is this order assigned to ship from
// — for stamping Order.dispatchWarehouseId before auto-invoicing.
//
// Deliberately NOT ORDER_ALL_FULFILLMENT_ORDERS_QUERY: that one drags
// lineItems(first: 100) per fulfilment order, and this runs on the paid-order
// path of every warehousing org. Shopify assigns fulfilment orders to a
// location at order creation, so the answer is already knowable at PAID time.

export interface OrderFulfillmentLocationNode {
  status: FulfillmentOrderStatus;
  assignedLocation: { location: { id: string } | null } | null;
}

export interface OrderFulfillmentLocationsResponse {
  order: {
    fulfillmentOrders: { nodes: OrderFulfillmentLocationNode[] };
  } | null;
}

export const ORDER_FULFILLMENT_LOCATIONS_QUERY = /* GraphQL */ `
  query OrderFulfillmentLocations($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 25) {
        nodes {
          status
          assignedLocation {
            location { id }
          }
        }
      }
    }
  }
`;

// Same shape as ORDER_FULFILLMENT_ORDERS_QUERY but WITHOUT the OPEN/IN_PROGRESS
// filter, so callers can act on fulfilment orders in any status — e.g. release a
// hold on an ON_HOLD fulfilment order, which the filtered query would hide.
export const ORDER_ALL_FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query OrderAllFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 25) {
        nodes {
          id
          status
          requestStatus
          assignedLocation {
            name
            location { id }
          }
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              totalQuantity
              lineItem {
                id
                title
                variantTitle
                sku
              }
            }
          }
        }
      }
    }
  }
`;

// ─── fulfillmentCreate ─────────────────────────────────────────────────────
// Shopify-side input groups line items by their fulfillment order.
// `notifyCustomer` lets Shopify send the shipping email.

export interface FulfillmentOrderLineItemsByFulfillmentOrderInput {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems?: Array<{ id: string; quantity: number }>;
}

export interface FulfillmentTrackingInput {
  number?: string | null;
  url?: string | null;
  company?: string | null;
}

export interface FulfillmentCreateVariables {
  fulfillment: {
    lineItemsByFulfillmentOrder: FulfillmentOrderLineItemsByFulfillmentOrderInput[];
    notifyCustomer?: boolean | null;
    trackingInfo?: FulfillmentTrackingInput | null;
  };
}

export interface FulfillmentNode {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
}

export interface FulfillmentCreateResponse {
  fulfillmentCreate: {
    fulfillment: FulfillmentNode | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        createdAt
        updatedAt
        trackingInfo { number url company }
      }
      userErrors { field message }
    }
  }
`;

// ─── fulfillmentTrackingInfoUpdate ─────────────────────────────────────────

export interface FulfillmentTrackingInfoUpdateVariables {
  fulfillmentId: string;
  trackingInfoInput: FulfillmentTrackingInput;
  notifyCustomer?: boolean | null;
}

export interface FulfillmentTrackingInfoUpdateResponse {
  fulfillmentTrackingInfoUpdate: {
    fulfillment: FulfillmentNode | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION = /* GraphQL */ `
  mutation FulfillmentTrackingInfoUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        status
        createdAt
        updatedAt
        trackingInfo { number url company }
      }
      userErrors { field message }
    }
  }
`;

// ─── fulfillmentCancel ─────────────────────────────────────────────────────

export interface FulfillmentCancelVariables {
  id: string;
}

export interface FulfillmentCancelResponse {
  fulfillmentCancel: {
    fulfillment: FulfillmentNode | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_CANCEL_MUTATION = /* GraphQL */ `
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment {
        id
        status
        createdAt
        updatedAt
        trackingInfo { number url company }
      }
      userErrors { field message }
    }
  }
`;

// ─── fulfillmentOrderHold / releaseHold — drives the vendor "On hold" status.
// NOTE: the FulfillmentOrderHoldInput shape is API-version sensitive. Calls are
// made best-effort (failures are logged, never block the local status update),
// so a version mismatch degrades gracefully rather than breaking the action.

export interface FulfillmentOrderHoldVariables {
  // The fulfillment order id is a SEPARATE argument — it is NOT inside the input.
  id: string;
  fulfillmentHold: {
    reason: string; // FulfillmentHoldReason enum, e.g. 'OTHER'
    reasonNotes?: string;
    // When provided, ONLY these FO line items are held (Shopify splits the FO).
    // Omitting this holds the ENTIRE fulfillment order — which is the bug we're
    // fixing for the per-product vendor hold.
    fulfillmentOrderLineItems?: Array<{ id: string; quantity: number }>;
  };
}

export interface FulfillmentOrderHoldResponse {
  fulfillmentOrderHold: {
    fulfillmentOrder: { id: string; status: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_ORDER_HOLD_MUTATION = /* GraphQL */ `
  mutation FulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

export interface FulfillmentOrderReleaseHoldVariables {
  id: string;
}

export interface FulfillmentOrderReleaseHoldResponse {
  fulfillmentOrderReleaseHold: {
    fulfillmentOrder: { id: string; status: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION = /* GraphQL */ `
  mutation FulfillmentOrderReleaseHold($id: ID!) {
    fulfillmentOrderReleaseHold(id: $id) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

// fulfillmentOrderOpen — marks a fulfilment order "ready for fulfilment",
// reverting an IN_PROGRESS (manually-reported-progress) FO back to OPEN. This is
// the counterpart to fulfillmentOrderReportProgress. Available since API 2026-01.
export interface FulfillmentOrderOpenVariables {
  id: string;
}

export interface FulfillmentOrderOpenResponse {
  fulfillmentOrderOpen: {
    fulfillmentOrder: { id: string; status: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_ORDER_OPEN_MUTATION = /* GraphQL */ `
  mutation FulfillmentOrderOpen($id: ID!) {
    fulfillmentOrderOpen(id: $id) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

// fulfillmentOrderReportProgress — drives Shopify's "Mark as in progress".
// Requires API version 2026-04+ and the write_merchant_managed_fulfillment_orders
// (or write_assigned_fulfillment_orders) scope. Takes the FulfillmentOrder GID.
export interface FulfillmentOrderReportProgressResponse {
  fulfillmentOrderReportProgress: {
    fulfillmentOrder: { id: string; status: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

export const FULFILLMENT_ORDER_REPORT_PROGRESS_MUTATION = /* GraphQL */ `
  mutation FulfillmentOrderReportProgress($id: ID!) {
    fulfillmentOrderReportProgress(id: $id) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

// fulfillmentEventCreate — drives "Mark as delivered" (and other shipment events).
// Takes the FULFILLMENT GID + a status (e.g. 'DELIVERED').
export interface FulfillmentEventCreateVariables {
  fulfillmentEvent: {
    fulfillmentId: string;
    status: string; // FulfillmentEventStatus, e.g. 'DELIVERED'
    happenedAt?: string;
  };
}

export interface FulfillmentEventCreateResponse {
  fulfillmentEventCreate: {
    fulfillmentEvent: { id: string; status: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const FULFILLMENT_EVENT_CREATE_MUTATION = /* GraphQL */ `
  mutation FulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent { id status }
      userErrors { field message }
    }
  }
`;

// ─── Order fulfillments WITH their line items ──────────────────────────────
// Used to attribute an existing Shopify fulfilment to a specific (vendor) line
// when our local lineItemIds metadata is missing — e.g. the order was fulfilled
// directly in Shopify admin, or before we started tagging fulfilments. Lets the
// per-product "mark delivered" / "unfulfil" actions work for ANY fulfilled line.
export interface OrderFulfillmentWithLinesNode {
  id: string;
  status: string;
  fulfillmentLineItems: {
    nodes: Array<{ quantity: number; lineItem: { id: string } | null }>;
  };
}

export interface OrderFulfillmentsWithLinesResponse {
  order: { fulfillments: OrderFulfillmentWithLinesNode[] } | null;
}

export const ORDER_FULFILLMENTS_WITH_LINES_QUERY = /* GraphQL */ `
  query OrderFulfillmentsWithLines($id: ID!) {
    order(id: $id) {
      fulfillments(first: 50) {
        id
        status
        fulfillmentLineItems(first: 100) {
          nodes {
            quantity
            lineItem { id }
          }
        }
      }
    }
  }
`;

// ─── Phase 4: Draft orders ──────────────────────────────────────────────────

export interface DraftOrderLineItemInput {
  /** Variant ID to add to the draft (use this OR title for custom items). */
  variantId?: string;
  /** Custom (no-variant) line item — must set title + originalUnitPrice. */
  title?: string;
  quantity: number;
  /** Override the variant's price. Use cents-as-decimal-string format. */
  originalUnitPrice?: string;
  /** Optional appliedDiscount block (value, type, etc.) — keep flexible. */
  appliedDiscount?: {
    title?: string;
    description?: string;
    value: number;
    valueType: 'FIXED_AMOUNT' | 'PERCENTAGE';
  };
}

export interface DraftOrderInputShape {
  /** Line items required for create; optional for update (partial patch). */
  lineItems?: DraftOrderLineItemInput[];
  email?: string | null;
  note?: string | null;
  tags?: string[];
  shippingAddress?: MailingAddressInput;
  billingAddress?: MailingAddressInput;
  customAttributes?: AttributeInput[];
  /** Customer GID for attaching an existing Shopify customer. */
  purchasingEntity?: { customerId: string };
}

/** Shopify DraftOrder response node (subset we read back). */
export interface DraftOrderNode {
  id: string;
  name: string;
  status: string;
  invoiceUrl: string | null;
  invoiceSentAt: string | null;
  email: string | null;
  totalPriceSet: MoneyBag;
  subtotalPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  order: { id: string; name: string } | null;
}

export interface DraftOrderCreateVariables {
  input: DraftOrderInputShape;
}

export interface DraftOrderCreateResponse {
  draftOrderCreate: {
    draftOrder: DraftOrderNode | null;
    userErrors: ShopifyUserError[];
  };
}

export const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        invoiceSentAt
        email
        totalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        createdAt
        updatedAt
        completedAt
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

// ─── draftOrderUpdate ──────────────────────────────────────────────────────

export interface DraftOrderUpdateVariables {
  id: string;
  input: DraftOrderInputShape;
}

export interface DraftOrderUpdateResponse {
  draftOrderUpdate: {
    draftOrder: DraftOrderNode | null;
    userErrors: ShopifyUserError[];
  };
}

export const DRAFT_ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        invoiceSentAt
        email
        totalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        createdAt
        updatedAt
        completedAt
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

// ─── draftOrderDelete ──────────────────────────────────────────────────────

export interface DraftOrderDeleteVariables {
  input: { id: string };
}

export interface DraftOrderDeleteResponse {
  draftOrderDelete: {
    deletedId: string | null;
    userErrors: ShopifyUserError[];
  };
}

export const DRAFT_ORDER_DELETE_MUTATION = /* GraphQL */ `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

// ─── draftOrderComplete ────────────────────────────────────────────────────

export interface DraftOrderCompleteVariables {
  id: string;
  paymentPending?: boolean;
}

export interface DraftOrderCompleteResponse {
  draftOrderComplete: {
    draftOrder: (DraftOrderNode & {
      order: { id: string; name: string; legacyResourceId: string } | null;
    }) | null;
    userErrors: ShopifyUserError[];
  };
}

export const DRAFT_ORDER_COMPLETE_MUTATION = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        name
        status
        completedAt
        order { id name legacyResourceId }
      }
      userErrors { field message }
    }
  }
`;

// ─── draftOrderInvoiceSend ─────────────────────────────────────────────────

export interface DraftOrderInvoiceSendVariables {
  id: string;
  email?: {
    to?: string | null;
    from?: string | null;
    subject?: string | null;
    customMessage?: string | null;
    bcc?: string[];
  };
}

export interface DraftOrderInvoiceSendResponse {
  draftOrderInvoiceSend: {
    draftOrder: (DraftOrderNode & {
      invoiceUrl: string | null;
      invoiceSentAt: string | null;
    }) | null;
    userErrors: ShopifyUserError[];
  };
}

export const DRAFT_ORDER_INVOICE_SEND_MUTATION = /* GraphQL */ `
  mutation DraftOrderInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        invoiceSentAt
      }
      userErrors { field message }
    }
  }
`;

// ─── Shop info ──────────────────────────────────────────────────────────────
// Replaces REST `shop.json` (403 for apps created after Shopify's REST
// sunset). Used by the OAuth callback and manual-connect validation.

export interface ShopInfoResponse {
  shop: {
    id: string; // gid://shopify/Shop/123
    name: string;
    currencyCode: string;
  };
}

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      id
      name
      currencyCode
    }
  }
`;

// ─── Webhook subscriptions ──────────────────────────────────────────────────
// Replaces REST `webhooks.json`. Topic enum values are the REST topic
// uppercased with `/` → `_` (products/create → PRODUCTS_CREATE).

export interface WebhookSubscriptionCreateVariables {
  topic: string;
  webhookSubscription: {
    callbackUrl: string;
    format: 'JSON';
  };
}

export interface WebhookSubscriptionCreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = /* GraphQL */ `
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

export interface WebhookSubscriptionsListResponse {
  webhookSubscriptions: {
    nodes: Array<{ id: string; topic: string }>;
  };
}

export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query WebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes { id topic }
    }
  }
`;

export interface WebhookSubscriptionDeleteResponse {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: ShopifyUserError[];
  };
}

export const WEBHOOK_SUBSCRIPTION_DELETE_MUTATION = /* GraphQL */ `
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

// ─── Entity counts (sync progress estimates) ────────────────────────────────
// Replace REST `/{resource}/count.json`. Informational only — callers treat
// failures as "unknown" (0), never fatal.

export interface ProductsCountResponse {
  productsCount: { count: number } | null;
}
export const PRODUCTS_COUNT_QUERY = /* GraphQL */ `
  query ProductsCount { productsCount { count } }
`;

export interface CustomersCountResponse {
  customersCount: { count: number } | null;
}
export const CUSTOMERS_COUNT_QUERY = /* GraphQL */ `
  query CustomersCount { customersCount { count } }
`;

export interface OrdersCountResponse {
  ordersCount: { count: number } | null;
}
export const ORDERS_COUNT_QUERY = /* GraphQL */ `
  query OrdersCount { ordersCount { count } }
`;

// ─── Products list (sync) ───────────────────────────────────────────────────
// Feeds `transformGraphqlProduct` → the REST snake_case shape `upsertProduct`
// consumes (shared with the products/* webhooks). The optional vendor
// metafield is inlined via @include so multi-vendor orgs don't need a
// follow-up call per product.

export interface ProductVariantSyncNode {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  position: number;
  taxable: boolean;
  inventoryQuantity: number | null;
  /** CONTINUE | DENY — REST `inventory_policy` in upper case. */
  inventoryPolicy: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: {
    id: string;
    requiresShipping: boolean;
    /** REST `inventory_management === 'shopify'`. */
    tracked: boolean;
    harmonizedSystemCode: string | null;
    countryCodeOfOrigin: string | null;
    unitCost: { amount: string; currencyCode: string } | null;
    measurement: { weight: { value: number; unit: string } | null } | null;
  } | null;
}

export interface ProductSyncNode {
  id: string;
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  status: string;
  tags: string[];
  handle: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  options: Array<{ name: string; values: string[]; position: number }>;
  media: {
    nodes: Array<{
      id: string;
      image?: { url: string; altText: string | null } | null;
    }>;
  };
  variants: { nodes: ProductVariantSyncNode[] };
  vendorMetafield?: { value: string } | null;
}

export interface ProductsListVariables {
  first: number;
  after?: string | null;
  /** Shopify search filter, e.g. `updated_at:>='2026-08-01T00:00:00.000Z'`.
   *  Null on a first backfill (pull everything). */
  query?: string | null;
  withMetafield: boolean;
  mfNamespace: string;
  mfKey: string;
}

export interface ProductsListResponse {
  products: {
    pageInfo: PageInfo;
    nodes: ProductSyncNode[];
  };
}

export const PRODUCTS_LIST_QUERY = /* GraphQL */ `
  query ProductsList(
    $first: Int!
    $after: String
    $query: String
    $withMetafield: Boolean!
    $mfNamespace: String
    $mfKey: String!
  ) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        descriptionHtml
        vendor
        productType
        status
        tags
        handle
        publishedAt
        createdAt
        updatedAt
        options { name values position }
        media(first: 50) {
          nodes {
            id
            ... on MediaImage {
              image { url altText }
            }
          }
        }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            position
            taxable
            inventoryQuantity
            inventoryPolicy
            selectedOptions { name value }
            inventoryItem {
              id
              requiresShipping
              tracked
              harmonizedSystemCode
              countryCodeOfOrigin
              unitCost { amount currencyCode }
              measurement { weight { value unit } }
            }
          }
        }
        vendorMetafield: metafield(namespace: $mfNamespace, key: $mfKey) @include(if: $withMetafield) {
          value
        }
      }
    }
  }
`;

// Lightweight variant-only products query for the inventory sync pass.
export interface ProductsInventoryResponse {
  products: {
    pageInfo: PageInfo;
    nodes: Array<{
      id: string;
      variants: { nodes: Array<{ id: string; inventoryQuantity: number | null }> };
    }>;
  };
}

export const PRODUCTS_INVENTORY_QUERY = /* GraphQL */ `
  query ProductsInventory($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        variants(first: 100) {
          nodes {
            id
            inventoryQuantity
          }
        }
      }
    }
  }
`;

// ─── Customers list (sync) ──────────────────────────────────────────────────
// NOTE: reading customer PII with a public app requires "Protected customer
// data access" to be enabled for the app in the Partner Dashboard.

export interface CustomerSyncNode {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  state: string;
  verifiedEmail: boolean;
  note: string | null;
  tags: string[];
  numberOfOrders: string;
  amountSpent: MoneyV2 | null;
  emailMarketingConsent: { marketingState: string } | null;
  addresses: MailingAddress[];
  defaultAddress: MailingAddress | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomersListVariables {
  first: number;
  after?: string | null;
  /** Shopify search filter, e.g. `updated_at:>='2026-08-01T00:00:00.000Z'`.
   *  Null on a first backfill (pull everything). */
  query?: string | null;
}

export interface CustomersListResponse {
  customers: {
    pageInfo: PageInfo;
    nodes: CustomerSyncNode[];
  };
}

export const CUSTOMERS_LIST_QUERY = /* GraphQL */ `
  query CustomersList($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        email
        firstName
        lastName
        phone
        state
        verifiedEmail
        note
        tags
        numberOfOrders
        amountSpent { amount currencyCode }
        emailMarketingConsent { marketingState }
        addresses {
          address1 address2 city province provinceCode country countryCodeV2
          zip firstName lastName name phone company
        }
        defaultAddress {
          address1 address2 city province provinceCode country countryCodeV2
          zip firstName lastName name phone company
        }
        createdAt
        updatedAt
      }
    }
  }
`;

// ─── Collections list (sync) ────────────────────────────────────────────────
// One connection covers both custom and smart collections — `ruleSet` is
// non-null only for smart collections. Product membership (previously REST
// `collects.json`) is inlined; oversized collections are drained with
// COLLECTION_PRODUCTS_QUERY.

export interface CollectionSyncNode {
  id: string;
  title: string;
  handle: string | null;
  sortOrder: string | null;
  updatedAt: string;
  ruleSet: { appliedDisjunctively: boolean } | null;
  products: {
    pageInfo: PageInfo;
    nodes: Array<{ id: string }>;
  };
}

export interface CollectionsListVariables {
  first: number;
  after?: string | null;
  /** Shopify search filter, e.g. `updated_at:>='2026-08-01T00:00:00.000Z'`.
   *  Null on a first backfill (pull everything). */
  query?: string | null;
}

export interface CollectionsListResponse {
  collections: {
    pageInfo: PageInfo;
    nodes: CollectionSyncNode[];
  };
}

export const COLLECTIONS_LIST_QUERY = /* GraphQL */ `
  query CollectionsList($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        sortOrder
        updatedAt
        ruleSet { appliedDisjunctively }
        products(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes { id }
        }
      }
    }
  }
`;

export interface CollectionProductsResponse {
  collection: {
    products: {
      pageInfo: PageInfo;
      nodes: Array<{ id: string }>;
    };
  } | null;
}

export const COLLECTION_PRODUCTS_QUERY = /* GraphQL */ `
  query CollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes { id }
      }
    }
  }
`;

// ─── Locations ──────────────────────────────────────────────────────────────
// Replaces REST `locations.json`. Two consumers with different needs:
//   - resolveLocationId  — wants only the primary, for order fulfillment.
//   - ShopifyLocationSyncService — wants EVERY location; each one is mirrored
//     as a CRM warehouse and holds its own stock.
// The second is why this paginates. It used to be a bare `locations(first: 50)`
// with no pageInfo, which silently truncated stores above 50 — invisible when
// only the primary was ever read, a whole warehouse of missing stock now.
// `includeInactive` is required to see deactivated locations at all; without it
// a location deactivated in Shopify simply vanishes from the response, which
// the sync would be unable to tell apart from one that was deleted.

export interface ShopifyLocationNode {
  id: string;
  name: string;
  isActive: boolean;
  isPrimary: boolean;
  // Seeds the mirrored warehouse's address once, when it has none. A warehouse
  // is a GST place of business and an invoice must be able to print where the
  // goods left from; there is no other source for that address.
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCode: string | null;
    phone: string | null;
  } | null;
}

export interface LocationsResponse {
  locations: {
    pageInfo: PageInfo;
    nodes: ShopifyLocationNode[];
  };
}

export const LOCATIONS_QUERY = /* GraphQL */ `
  query Locations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        isActive
        isPrimary
        address {
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCode
          phone
        }
      }
    }
  }
`;

// ─── Per-location inventory (multi-location pull) ───────────────────────────
// The per-location counterpart to PRODUCTS_INVENTORY_QUERY. That one reads
// `variant.inventoryQuantity`, which is Shopify's SUM across every location —
// fine when the CRM tracked one number, useless once each location maps to its
// own warehouse holding its own stock.
//
// Rooted at `productVariants` rather than nesting products → variants: the
// inner connection would cap at 100 variants per product with no way to page
// the remainder, and we need every variant regardless of how they group.
//
// `quantities(names: ["available"])` returns a list, so the caller must find
// the entry by name rather than indexing [0].

export interface VariantInventoryLevelsResponse {
  productVariants: {
    pageInfo: PageInfo;
    nodes: Array<{
      id: string;
      inventoryItem: {
        id: string;
        inventoryLevels: {
          pageInfo: PageInfo;
          nodes: Array<{
            location: { id: string };
            quantities: Array<{ name: string; quantity: number }>;
          }>;
        };
      } | null;
    }>;
  };
}

export const VARIANT_INVENTORY_LEVELS_QUERY = /* GraphQL */ `
  query VariantInventoryLevels($first: Int!, $after: String, $levelsFirst: Int!) {
    productVariants(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        inventoryItem {
          id
          inventoryLevels(first: $levelsFirst) {
            pageInfo {
              hasNextPage
            }
            nodes {
              location {
                id
              }
              # NO BACKTICKS IN HERE — this is a TS template literal and one
              # would terminate the string.
              # committed = units Shopify has allocated to placed-but-unfulfilled
              # orders. Still physically in the building, so without it our
              # on-hand under-counts by exactly that amount.
              quantities(names: ["available", "committed"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

// ─── orderCreate (push CRM offline orders into Shopify) ─────────────────────
// Replaces REST `POST /orders.json`. A successful SALE transaction covering
// the total marks the order paid; inventory behaviour rides on `options`.

export interface OrderCreatePushVariables {
  order: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface OrderCreatePushResponse {
  orderCreate: {
    order: {
      id: string;
      name: string;
      /// The line items Shopify just created. Read back so `pushOrder` can
      /// stamp Shopify's line ids onto the local `OrderLineItem` rows — without
      /// them the local rows keep their `manual_<uuid>` ids, the `orders/create`
      /// webhook matches nothing, and the order ends up holding TWO copies of
      /// every item.
      lineItems: {
        nodes: Array<{
          id: string;
          quantity: number;
          sku: string | null;
          variant: { id: string } | null;
        }>;
      };
    } | null;
    userErrors: ShopifyUserError[];
  };
}

export const ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        lineItems(first: 100) {
          nodes { id quantity sku variant { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

// ─── productSet (one-shot product create) ───────────────────────────────────
// Replaces REST `POST /products.json` + the follow-up inventory-item meta,
// inventory seeding, and (partially) image handling — options, variants,
// files, per-variant inventory quantities and inventory-item fields all ride
// in a single synchronous mutation.

export interface ProductSetResponse {
  productSet: {
    product: {
      id: string;
      variants: { nodes: Array<{ id: string; inventoryItem: { id: string } | null }> };
      media: { nodes: Array<{ id: string }> };
    } | null;
    userErrors: ShopifyUserError[];
  };
}

export const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        variants(first: 100) {
          nodes {
            id
            inventoryItem { id }
          }
        }
        media(first: 50) {
          nodes { id }
        }
      }
      userErrors { field message }
    }
  }
`;

// ─── productUpdate (top-level fields of an already-synced product) ──────────

export interface ProductUpdatePushResponse {
  productUpdate: {
    product: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const PRODUCT_UPDATE_MUTATION = /* GraphQL */ `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

// ─── productVariantsBulkUpdate / Create ─────────────────────────────────────
// Replace REST `PUT /variants/{id}.json`, `POST /products/{id}/variants.json`
// and `PUT /inventory_items/{id}.json` — sku, cost, weight, HS code and
// country-of-origin all live on `inventoryItem` in the bulk input.

export interface ProductVariantsBulkResponse {
  productVariants: Array<{ id: string; inventoryItem: { id: string } | null }> | null;
  userErrors: ShopifyUserError[];
}

export interface ProductVariantsBulkUpdateResponse {
  productVariantsBulkUpdate: ProductVariantsBulkResponse;
}

export const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = /* GraphQL */ `
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        inventoryItem { id }
      }
      userErrors { field message }
    }
  }
`;

export interface ProductVariantsBulkCreateResponse {
  productVariantsBulkCreate: ProductVariantsBulkResponse;
}

export const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = /* GraphQL */ `
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
        inventoryItem { id }
      }
      userErrors { field message }
    }
  }
`;

// ─── product options (structure of an already-synced product) ───────────────
// The update push reconciles the CRM's `Product.options` against Shopify's
// live options before touching variants — a variant that names an option
// Shopify has never heard of is rejected outright. Planning lives in
// product-options-reconcile.util.ts; these are the documents it drives.

export interface ShopifyLiveOption {
  id: string;
  name: string;
  position: number;
  values: string[];
}

export interface ShopifyLiveVariantOptions {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface ProductOptionsSnapshot {
  id: string;
  options: ShopifyLiveOption[];
  variants: { nodes: ShopifyLiveVariantOptions[] };
}

export interface ProductOptionsQueryResponse {
  product: ProductOptionsSnapshot | null;
}

export const PRODUCT_OPTIONS_QUERY = /* GraphQL */ `
  query ProductOptionsForPush($id: ID!) {
    product(id: $id) {
      id
      options { id name position values }
      variants(first: 100) {
        nodes {
          id
          selectedOptions { name value }
        }
      }
    }
  }
`;

export interface ProductOptionsCreateResponse {
  productOptionsCreate: {
    product: ProductOptionsSnapshot | null;
    userErrors: ShopifyUserError[];
  };
}

// LEAVE_AS_IS: no new variants; existing variants receive the FIRST value of
// each new option (Shopify Admin does the same). The CRM mirrors that rule in
// ProductService.generateVariantsFromOptions, so both sides agree on which
// combination each pre-existing variant now represents.
export const PRODUCT_OPTIONS_CREATE_MUTATION = /* GraphQL */ `
  mutation ProductOptionsCreate(
    $productId: ID!
    $options: [OptionCreateInput!]!
    $variantStrategy: ProductOptionCreateVariantStrategy
  ) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
      product {
        id
        options { id name position values }
        variants(first: 100) {
          nodes {
            id
            selectedOptions { name value }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

export interface ProductOptionUpdateResponse {
  productOptionUpdate: {
    product: { id: string; options: ShopifyLiveOption[] } | null;
    userErrors: ShopifyUserError[];
  };
}

export const PRODUCT_OPTION_UPDATE_MUTATION = /* GraphQL */ `
  mutation ProductOptionUpdate(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $variantStrategy: ProductOptionUpdateVariantStrategy
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      variantStrategy: $variantStrategy
    ) {
      product {
        id
        options { id name position values }
      }
      userErrors { field message code }
    }
  }
`;

export interface ProductOptionsDeleteResponse {
  productOptionsDelete: {
    deletedOptionsIds: string[] | null;
    product: ProductOptionsSnapshot | null;
    userErrors: ShopifyUserError[];
  };
}

// POSITION: an option with variants can go; duplicate variants that result
// are removed, highest position first. DEFAULT only allows a one-value option.
export const PRODUCT_OPTIONS_DELETE_MUTATION = /* GraphQL */ `
  mutation ProductOptionsDelete(
    $productId: ID!
    $options: [ID!]!
    $strategy: ProductOptionDeleteStrategy
  ) {
    productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
      deletedOptionsIds
      product {
        id
        options { id name position values }
        variants(first: 100) {
          nodes {
            id
            selectedOptions { name value }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

export interface ProductOptionsReorderResponse {
  productOptionsReorder: {
    product: ProductOptionsSnapshot | null;
    userErrors: ShopifyUserError[];
  };
}

export const PRODUCT_OPTIONS_REORDER_MUTATION = /* GraphQL */ `
  mutation ProductOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      product {
        id
        options { id name position values }
        variants(first: 100) {
          nodes {
            id
            selectedOptions { name value }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

// ─── inventorySetQuantities ─────────────────────────────────────────────────
// Replaces REST `POST /inventory_levels/set.json`.

export interface InventorySetQuantitiesResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: { createdAt: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export const INVENTORY_SET_QUANTITIES_MUTATION = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

// ─── Variant → inventory item backfill ──────────────────────────────────────
// Replaces REST `GET /variants/{id}.json` (older pulls didn't persist
// inventory_item_id locally).

export interface VariantInventoryItemResponse {
  productVariant: { id: string; inventoryItem: { id: string } | null } | null;
}

export const VARIANT_INVENTORY_ITEM_QUERY = /* GraphQL */ `
  query VariantInventoryItem($id: ID!) {
    productVariant(id: $id) {
      id
      inventoryItem { id }
    }
  }
`;

// ─── shopifyqlQuery ────────────────────────────────────────────────────────
// Runs a ShopifyQL string against the Analytics API. In API version 2026-01
// the field returns a concrete `ShopifyqlQueryResponse` object (NOT a union)
// with two fields:
//   * `parseErrors: [String!]!` — empty when the query parsed; otherwise an
//     array of human-readable error strings (the query string itself was
//     malformed).
//   * `tableData: ShopifyqlTableData` — nullable; populated when parsing
//     succeeded.
//
// `rows` is a JSON scalar (an array of arrays). Each inner array's values
// correspond positionally to `columns`. Values come back natively typed
// (numbers as numbers, strings as strings, null where the cell is empty).
//
// Required scope: `read_reports`. The `sessions` / `online_store_visitors`
// datasets additionally require the merchant to be on Shopify Advanced or
// Plus (Basic plans surface as HTTP 406 before the GraphQL envelope is ever
// returned — handled by the analytics service, not this file).

export interface ShopifyqlTableDataColumn {
  name: string;
  /// One of: STRING, NUMBER, PERCENT, CURRENCY, MONEY, DATE, DATETIME, ...
  dataType: string;
  displayName: string;
  subType?: string | null;
}

export interface ShopifyqlTableData {
  columns: ShopifyqlTableDataColumn[];
  /// JSON scalar — row-major 2D array; cell types follow `columns[i].dataType`.
  rows: Array<Array<string | number | boolean | null>>;
}

export interface ShopifyqlQueryResponse {
  shopifyqlQuery: {
    parseErrors: string[];
    tableData: ShopifyqlTableData | null;
  };
}

export interface ShopifyqlQueryVariables {
  shopifyql: string;
}

export const SHOPIFYQL_QUERY = /* GraphQL */ `
  query AnalyticsShopifyqlQuery($shopifyql: String!) {
    shopifyqlQuery(query: $shopifyql) {
      parseErrors
      tableData {
        columns { name dataType displayName }
        rows
      }
    }
  }
`;


// ─── Web Pixel (storefront analytics extension) ─────────────────────────────

export interface WebPixelCreateResponse {
  webPixelCreate: {
    webPixel: { id: string; settings: string } | null;
    userErrors: Array<{ code?: string; field?: string[]; message: string }>;
  };
}
export const WEB_PIXEL_CREATE_MUTATION = /* GraphQL */ `
  mutation WebPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { code field message }
    }
  }
`;

export interface WebPixelUpdateResponse {
  webPixelUpdate: {
    webPixel: { id: string; settings: string } | null;
    userErrors: Array<{ code?: string; field?: string[]; message: string }>;
  };
}
export const WEB_PIXEL_UPDATE_MUTATION = /* GraphQL */ `
  mutation WebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { code field message }
    }
  }
`;

export interface WebPixelQueryResponse {
  webPixel: { id: string; settings: string } | null;
}
// Returns THIS app's pixel on the shop (used to recover the id when create says TAKEN).
export const WEB_PIXEL_QUERY = /* GraphQL */ `
  query WebPixel { webPixel { id settings } }
`;