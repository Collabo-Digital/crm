import { ProductService } from './product.service';

/**
 * Both product codes are minted at creation, so a merchant never presses a
 * button to get one.
 *
 * Until this existed the two behaved differently for no reason a merchant
 * could see: barcodes appeared by themselves, SKUs did not. The Inventory
 * screen therefore carried a permanent "Generate all missing SKUs" button
 * beside an identical-looking "Generate all missing barcodes" that was already
 * dead weight, and neither word was defined anywhere in the app.
 *
 * What these protect:
 *   1. Both codes are minted on the creation paths, or the dialog they
 *      replaced becomes load-bearing again.
 *   2. The generator is asked to fill gaps only, so a SKU typed into the same
 *      request survives.
 *   3. Minting never fails the write — a product without a code is
 *      recoverable, a failed create is not.
 */

const ORG = 'org_1';
const USER = 'user_1';

function build() {
  const created = {
    id: 'p1',
    title: 'Kerala Cotton Saree',
    variants: [
      { id: 'v1', sku: 'TYPED-1', barcode: null, barcodeSource: null, inventoryQuantity: 0 },
      { id: 'v2', sku: null, barcode: null, barcodeSource: null, inventoryQuantity: 0 },
    ],
    images: [],
  };

  const tx = {
    channel: { upsert: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
    product: { create: jest.fn().mockResolvedValue(created) },
  };

  const prisma = {
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    productVariant: { findFirst: jest.fn().mockResolvedValue(null) },
    channel: { findUnique: jest.fn().mockResolvedValue(null) },
    product: { findFirst: jest.fn(), update: jest.fn() },
  };

  const skuGenerator = {
    generateSkus: jest.fn().mockResolvedValue({ generated: 1, skipped: 0, conflicts: [] }),
    generateBarcodes: jest.fn().mockResolvedValue({ generated: 2, skipped: 0, conflicts: [] }),
    assertCodeFree: jest.fn().mockResolvedValue(undefined),
  };

  const inventoryLedger = {
    recordInitialQuantities: jest.fn().mockResolvedValue(undefined),
    ensureStockRows: jest.fn().mockResolvedValue(undefined),
  };

  const settings = {
    getProductSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: false }),
  };

  const service = new ProductService(
    prisma as never,
    { enqueue: jest.fn() } as never,
    settings as never,
    inventoryLedger as never,
    skuGenerator as never,
    {} as never,
    {} as never,
  );

  return { service, prisma, skuGenerator, created };
}

const DTO = {
  title: 'Kerala Cotton Saree',
  options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
  variants: [
    { sku: 'TYPED-1', price: 100, option1: 'Red' },
    { price: 100, option1: 'Blue' },
  ],
} as never;

describe('automatic product codes on create', () => {
  it('mints a SKU for every new variant without being asked', async () => {
    const { service, skuGenerator } = build();

    await service.create(ORG, USER, DTO);

    expect(skuGenerator.generateSkus).toHaveBeenCalledTimes(1);
    expect(skuGenerator.generateSkus).toHaveBeenCalledWith(ORG, {
      variantIds: ['v1', 'v2'],
    });
  });

  it('still mints the barcode, and mints the SKU first', async () => {
    // Both draw from claimSequence, so SKU-then-barcode keeps a variant's two
    // codes consecutive rather than interleaved with its siblings'.
    const { service, skuGenerator } = build();

    await service.create(ORG, USER, DTO);

    expect(skuGenerator.generateBarcodes).toHaveBeenCalledWith(ORG, {
      variantIds: ['v1', 'v2'],
      format: 'short',
    });
    const skuOrder = skuGenerator.generateSkus.mock.invocationCallOrder[0];
    const barcodeOrder = skuGenerator.generateBarcodes.mock.invocationCallOrder[0];
    expect(skuOrder).toBeLessThan(barcodeOrder);
  });

  it('passes no filter and no overwrite, so a typed SKU is never clobbered', async () => {
    // loadTargets then defaults to 'missing-sku'. Either flag would let a
    // create overwrite the SKU the merchant typed in the same request.
    const { service, skuGenerator } = build();

    await service.create(ORG, USER, DTO);

    const [, args] = skuGenerator.generateSkus.mock.calls[0];
    expect(args).not.toHaveProperty('filter');
    expect(args).not.toHaveProperty('overwrite');
  });

  it('does not fail the create when the generator throws', async () => {
    // The product already exists by this point and is recoverable without a
    // code; throwing here would lose the whole write.
    const { service, skuGenerator, created } = build();
    skuGenerator.generateSkus.mockRejectedValue(new Error('sequence locked'));

    await expect(service.create(ORG, USER, DTO)).resolves.toMatchObject({
      id: created.id,
    });
    // …and the barcode is still attempted despite the SKU failure.
    expect(skuGenerator.generateBarcodes).toHaveBeenCalled();
  });
});
