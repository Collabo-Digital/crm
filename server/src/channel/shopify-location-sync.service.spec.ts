import { ShopifyLocationSyncService } from './shopify-location-sync.service';

/**
 * A variant Shopify stocks at quantity zero must still end up with a
 * `stock_levels` row.
 *
 * Why this is pinned: `applyMovement` -> `ensureLevel` used to be the only
 * code path that created a row, and the reconcile skipped it whenever the
 * delta was zero. Since `loadAvailable` read a missing row as 0, a variant
 * sitting at 0 in Shopify produced a zero delta forever and never got a row —
 * and `InventoryService.listStock` reads `stock_levels` only, so the variant
 * was absent from the inventory screen entirely rather than showing as out of
 * stock. Found in production on 2026-09-04: 351 variants with no row at all
 * and 2,840 missing their second-location row.
 */

const ORG = 'org_1';
const CHANNEL = 'ch_1';
const WAREHOUSE = 'wh_main';
const LOCATION = '73143058682';
const VARIANT = 'var_1';
const ITEM_ID = '55512345';

/** One page holding a single variant stocked at `available` in one location. */
function onePage(available: number, committed?: number) {
  const quantities: Array<{ name: string; quantity: number }> = [
    { name: 'available', quantity: available },
  ];
  if (committed !== undefined) {
    quantities.push({ name: 'committed', quantity: committed });
  }
  return {
    productVariants: {
      nodes: [
        {
          inventoryItem: {
            id: `gid://shopify/InventoryItem/${ITEM_ID}`,
            inventoryLevels: {
              nodes: [
                {
                  location: { id: `gid://shopify/Location/${LOCATION}` },
                  quantities,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function build(
  available: number,
  existingRows: unknown[],
  committed?: number,
) {
  const prisma = {
    warehouse: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: WAREHOUSE, shopifyLocationId: LOCATION }]),
    },
    productVariant: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: VARIANT, inventoryItemId: ITEM_ID }]),
    },
    stockLevel: {
      findMany: jest.fn().mockResolvedValue(existingRows),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    syncLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'log_1', cursor: null }),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const graphql = {
    request: jest.fn().mockResolvedValue(onePage(available, committed)),
  };
  const ledger = { applyMovement: jest.fn().mockResolvedValue(undefined) };

  const service = new ShopifyLocationSyncService(
    prisma as any,
    graphql as any,
    {} as any,
    ledger as any,
  );
  return { service, prisma, ledger };
}

const getAuth = async () =>
  ({ token: 'tok', shopDomain: 'shop.myshopify.com' }) as any;

describe('ShopifyLocationSyncService.pullLocationInventory', () => {
  it('creates a zero row for a level Shopify stocks at 0 when we hold none', async () => {
    const { service, prisma, ledger } = build(0, []);

    await service.pullLocationInventory(CHANNEL, ORG, getAuth);

    expect(prisma.stockLevel.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.stockLevel.createMany).toHaveBeenCalledWith({
      data: [
        { organizationId: ORG, variantId: VARIANT, warehouseId: WAREHOUSE },
      ],
      skipDuplicates: true,
    });
    // Nothing moved: an empty bucket is not a stock movement, so no ledger
    // row and therefore no inventory_events entry.
    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });

  it('does not re-create a row that already exists at zero', async () => {
    const { service, prisma, ledger } = build(0, [
      { variantId: VARIANT, warehouseId: WAREHOUSE, available: 0 },
    ]);

    await service.pullLocationInventory(CHANNEL, ORG, getAuth);

    expect(prisma.stockLevel.createMany).not.toHaveBeenCalled();
    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });

  it('still applies a movement when the quantity actually differs', async () => {
    const { service, prisma, ledger } = build(5, [
      { variantId: VARIANT, warehouseId: WAREHOUSE, available: 2 },
    ]);

    await service.pullLocationInventory(CHANNEL, ORG, getAuth);

    expect(ledger.applyMovement).toHaveBeenCalledTimes(1);
    expect(ledger.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        variantId: VARIANT,
        warehouseId: WAREHOUSE,
        quantity: 3,
      }),
    );
    // applyMovement -> ensureLevel creates the row itself in this path.
    expect(prisma.stockLevel.createMany).not.toHaveBeenCalled();
  });

  it('skips levels at locations with no mapped warehouse', async () => {
    const { service, prisma, ledger } = build(0, []);
    prisma.warehouse.findMany.mockResolvedValue([
      { id: 'wh_other', shopifyLocationId: '99999999' },
    ]);

    await service.pullLocationInventory(CHANNEL, ORG, getAuth);

    expect(prisma.stockLevel.createMany).not.toHaveBeenCalled();
    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });
});

/**
 * Shopify owns location names, the same way it owns per-location quantities.
 * Before this, syncLocations wrote only isActive and address/GSTIN enrichment
 * onto an existing warehouse, so the name set at create time was permanent —
 * and Shrishti Jewels’ primary location sat on screen as the placeholder
 * "Main Warehouse" that enable() seeds, reading as a location that had never
 * synced at all.
 */
describe('ShopifyLocationSyncService.adoptLocationName', () => {
  const svc = new ShopifyLocationSyncService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  ) as any;

  const SHOPIFY_NAME = 'Shrishti Jewels 12 Stadium Bypass Road Selvapalayam';

  it('takes the Shopify name verbatim, replacing the seeded placeholder', () => {
    expect(
      svc.adoptLocationName({ name: SHOPIFY_NAME }, { name: 'Main Warehouse' }),
    ).toEqual({ name: SHOPIFY_NAME });
  });

  it('overwrites any existing name, so a Shopify rename propagates', () => {
    expect(
      svc.adoptLocationName({ name: SHOPIFY_NAME }, { name: 'Kochi Store' }),
    ).toEqual({ name: SHOPIFY_NAME });
  });

  it('is a no-op when the name already matches', () => {
    expect(
      svc.adoptLocationName({ name: SHOPIFY_NAME }, { name: SHOPIFY_NAME }),
    ).toEqual({});
  });

  it('is a no-op when Shopify sends no usable name', () => {
    const cur = { name: 'Main Warehouse' };
    expect(svc.adoptLocationName({ name: '   ' }, cur)).toEqual({});
    expect(svc.adoptLocationName({ name: undefined }, cur)).toEqual({});
  });

  it('keeps a very long Shopify name verbatim', () => {
    // Merchants must see the location name exactly as Shopify shows it. This
    // used to truncate at 100, which chopped real names silently.
    const long = 'x'.repeat(150);
    const out = svc.adoptLocationName(
      { name: long },
      { name: 'Main Warehouse' },
    );
    expect(out.name).toBe(long);
  });
});

/**
 * Shopify's COMMITTED is the quantity promised to placed-but-unfulfilled
 * orders. Those units are still physically on the shelf, and our `on_hand` is a
 * generated sum of the buckets — so leaving RESERVED at zero understated on
 * hand by exactly the committed amount, and a merchant counting the shelf found
 * us wrong whenever an order was open.
 *
 * It is mirrored, never computed: the Admin API cannot write `committed` at
 * all, so Shopify is the only possible source.
 */
describe('ShopifyLocationSyncService — committed mirrors into RESERVED', () => {
  const RESERVED = 'RESERVED';

  it('moves committed units into RESERVED when Shopify reports them', async () => {
    const { service, ledger } = build(
      10,
      [{ variantId: VARIANT, warehouseId: WAREHOUSE, available: 10, reserved: 0 }],
      3,
    );

    await service.pullLocationInventory(ORG, CHANNEL, getAuth);

    const reservedMoves = ledger.applyMovement.mock.calls
      .map(([a]: [any]) => a)
      .filter((a: any) => a.toBucket === RESERVED || a.fromBucket === RESERVED);
    expect(reservedMoves).toHaveLength(1);
    expect(reservedMoves[0]).toMatchObject({
      variantId: VARIANT,
      warehouseId: WAREHOUSE,
      fromBucket: null,
      toBucket: RESERVED,
      quantity: 3,
      reason: 'sync',
    });
  });

  it('does not touch AVAILABLE when only committed changed', async () => {
    const { service, ledger } = build(
      10,
      [{ variantId: VARIANT, warehouseId: WAREHOUSE, available: 10, reserved: 0 }],
      3,
    );

    await service.pullLocationInventory(ORG, CHANNEL, getAuth);

    // Shopify's `available` already excludes its committed, and the available
    // reconcile writes that figure verbatim — moving the units out of AVAILABLE
    // here as well would deduct them twice.
    const availableMoves = ledger.applyMovement.mock.calls
      .map(([a]: [any]) => a)
      .filter((a: any) => a.toBucket === 'AVAILABLE' || a.fromBucket === 'AVAILABLE');
    expect(availableMoves).toHaveLength(0);
  });

  it('releases RESERVED when Shopify reports the order fulfilled', async () => {
    const { service, ledger } = build(
      10,
      [{ variantId: VARIANT, warehouseId: WAREHOUSE, available: 10, reserved: 3 }],
      0,
    );

    await service.pullLocationInventory(ORG, CHANNEL, getAuth);

    const reservedMoves = ledger.applyMovement.mock.calls
      .map(([a]: [any]) => a)
      .filter((a: any) => a.toBucket === RESERVED || a.fromBucket === RESERVED);
    expect(reservedMoves).toHaveLength(1);
    expect(reservedMoves[0]).toMatchObject({
      fromBucket: RESERVED,
      toBucket: null,
      quantity: 3,
    });
  });

  it('writes nothing when committed is unchanged', async () => {
    const { service, ledger } = build(
      10,
      [{ variantId: VARIANT, warehouseId: WAREHOUSE, available: 10, reserved: 3 }],
      3,
    );

    await service.pullLocationInventory(ORG, CHANNEL, getAuth);

    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });

  it('leaves RESERVED alone when Shopify omits committed', async () => {
    const { service, ledger } = build(
      10,
      [{ variantId: VARIANT, warehouseId: WAREHOUSE, available: 10, reserved: 3 }],
    );

    await service.pullLocationInventory(ORG, CHANNEL, getAuth);

    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });
});
