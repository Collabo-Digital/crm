-- Counter sales (MANUAL channel) were stamped FULFILLED at creation with
-- nothing shipped: the header said Fulfilled while every line said
-- 0 shipped. `createOfflineOrder` now derives the header from the lines;
-- this re-derives it for the rows already written.
--
-- Scope is deliberately narrow: MANUAL orders only, and only those whose
-- lines carry no evidence of shipping at all (no fulfilled units and no line
-- marked fulfilled/delivered). A manual order that was later fulfilled in the
-- CRM has such a line and is left alone. Shopify orders are untouched — the
-- sync gives their lines a status but no count, which is exactly the case
-- `computeFulfillmentStatus` guards for, and their headers come from Shopify.
--
-- Idempotent: a second run matches nothing.
UPDATE "orders" o
SET "fulfillment_status" = 'UNFULFILLED'
FROM "channels" c
WHERE c."id" = o."channel_id"
  AND c."platform" = 'MANUAL'
  AND o."fulfillment_status" = 'FULFILLED'
  AND o."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "order_line_items" li
    WHERE li."order_id" = o."id"
      AND (
        li."fulfilled_quantity" > 0
        OR li."fulfillment_status" IN ('fulfilled', 'delivered')
      )
  );
