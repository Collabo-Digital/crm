export const INVENTORY_QUEUE = 'inventory';

/**
 * Inventory background jobs. Both are idempotent end-to-end (StockLevel
 * creates skip existing rows; ledger rows carry idempotency keys), so BullMQ
 * retries are safe.
 */
export type InventoryJobData =
  | {
      type: 'enable-seed';
      organizationId: string;
      /** User who triggered the enable — stamped as the ledger actor. */
      userId?: string;
    }
  | {
      /** The start-up switch of an existing workspace to stock locations. */
      type: 'switch-over';
      organizationId: string;
    };

/** One switch-over per workspace, whichever server starts first. */
export const switchOverJobId = (orgId: string) => `locations-switch-over-${orgId}`;
