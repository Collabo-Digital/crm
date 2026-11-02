import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductService } from './product.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';

/**
 * Opening stock per location when a product (or a variant) is added.
 *
 * The ledger here is the real InventoryLedgerService over a small in-memory
 * database, so what is pinned is what a merchant sees afterwards: which
 * locations hold a row, what each holds, the history entries naming them, and
 * the variant's cached quantity — the same three things an Inventory
 * adjustment leaves behind.
 */

const ORG = 'org_1';
const USER = 'user_1';
const MAIN = 'wh_main';
const KOCHI = 'wh_kochi';
const CLOSED = 'wh_closed';

type Row = Record<string, any>;

function fakeDb(opts: { warehousing?: boolean } = {}) {
  const warehouses: Row[] = [
    { id: MAIN, organizationId: ORG, name: 'Main warehouse', isActive: true, isDefault: true },
    { id: KOCHI, organizationId: ORG, name: 'Kochi store', isActive: true, isDefault: false },
    { id: CLOSED, organizationId: ORG, name: 'Old godown', isActive: false, isDefault: false },
    { id: 'wh_other_org', organizationId: 'org_2', name: 'Elsewhere', isActive: true, isDefault: true },
  ];
  const variants: Row[] = [];
  const stockLevels: Row[] = [];
  const events: Row[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;

  const db: any = {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(db)),
    // applyMovement's row lock, and nothing else here.
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn(async (sql: string, levelId: string, quantity: number) => {
      const level = stockLevels.find((l) => l.id === levelId);
      if (!level) return 0;
      for (const [, column, sign] of sql.matchAll(/"(\w+)" = "\w+" ([+-]) \$2/g)) {
        level[column] += sign === '+' ? quantity : -quantity;
      }
      return 1;
    }),
    channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
    warehouse: {
      findMany: jest.fn(async ({ where }: any) =>
        warehouses.filter(
          (w) => where.id.in.includes(w.id) && w.organizationId === where.organizationId,
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        warehouses.find((w) => w.organizationId === where.organizationId && w.isDefault) ?? null,
      ),
    },
    product: {
      create: jest.fn(async ({ data }: any) => {
        const productId = id('p');
        const created = data.variants.create.map((v: Row) => ({ ...v, id: id('v'), productId }));
        variants.push(...created);
        return {
          id: productId,
          title: data.title,
          metadata: data.metadata,
          variants: [...created].sort((a, b) => a.position - b.position),
          images: [],
          channel: { id: 'ch_manual' },
        };
      }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'p_existing',
        vendor: null,
        channel: { platform: 'MANUAL' },
      }),
      findUnique: jest.fn().mockResolvedValue({ metadata: {} }),
    },
    productVariant: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(async ({ where }: any) => variants.find((v) => v.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: id('v') };
        variants.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = variants.find((v) => v.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    stockLevel: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) {
          const exists = stockLevels.some(
            (l) => l.variantId === d.variantId && l.warehouseId === d.warehouseId,
          );
          if (!exists) {
            stockLevels.push({ id: id('sl'), locationId: null, available: 0, reserved: 0, qc: 0, damaged: 0, ...d });
          }
        }
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        stockLevels.find(
          (l) => l.variantId === where.variantId && l.warehouseId === where.warehouseId,
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('sl'), locationId: null, available: 0, reserved: 0, qc: 0, damaged: 0, ...data };
        stockLevels.push(row);
        return row;
      }),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          available: stockLevels
            .filter((l) => l.variantId === where.variantId)
            .reduce((sum, l) => sum + l.available, 0),
        },
      })),
    },
    inventoryEvent: {
      create: jest.fn(async ({ data }: any) => events.push(data)),
      createMany: jest.fn(async ({ data }: any) => events.push(...data)),
    },
  };

  const settings = {
    getInventorySettings: jest
      .fn()
      .mockResolvedValue({ warehousingEnabled: opts.warehousing ?? true }),
    getProductSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: false }),
  };
  const ledger = new InventoryLedgerService(db, settings as never);
  const skuGenerator = {
    generateSkus: jest.fn().mockResolvedValue({}),
    generateBarcodes: jest.fn().mockResolvedValue({}),
    assertCodeFree: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ProductService(
    db,
    {} as never,
    settings as never,
    ledger,
    skuGenerator as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const rowsOf = (variantId: string) =>
    stockLevels
      .filter((l) => l.variantId === variantId)
      .map((l) => ({ warehouseId: l.warehouseId, available: l.available }))
      .sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
  const cacheOf = (variantId: string) => variants.find((v) => v.id === variantId)!.inventoryQuantity;
  return { service, db, rowsOf, cacheOf, events, stockLevels };
}

const shirt = (variant: Record<string, unknown>) =>
  ({ title: 'Linen shirt', variant: { price: 1000, ...variant } }) as CreateProductDto;

describe('ProductService.create — opening stock per location', () => {
  it('stocks each chosen location with its quantity, and only those', async () => {
    const { service, rowsOf } = fakeDb();
    const product = await service.create(ORG, USER, shirt({
      stock: [{ warehouseId: KOCHI, quantity: 5 }, { warehouseId: MAIN, quantity: 3 }],
    }));

    expect(rowsOf(product.variants[0].id)).toEqual([
      { warehouseId: KOCHI, available: 5 },
      { warehouseId: MAIN, available: 3 },
    ]);
  });

  it('records one opening-stock entry per location, naming it, by the person who added it', async () => {
    const { service, events } = fakeDb();
    const product = await service.create(ORG, USER, shirt({
      stock: [{ warehouseId: KOCHI, quantity: 5 }, { warehouseId: MAIN, quantity: 3 }],
    }));

    expect(events).toEqual([
      expect.objectContaining({
        warehouseId: KOCHI, reason: 'initial', changeAmount: 5, quantityBefore: 0, quantityAfter: 5,
        fromBucket: null, toBucket: 'AVAILABLE', referenceType: 'product', referenceId: product.id, actorId: USER,
      }),
      expect.objectContaining({
        warehouseId: MAIN, reason: 'initial', changeAmount: 3, quantityBefore: 5, quantityAfter: 8,
      }),
    ]);
  });

  it('keeps the cached quantity at the sum, and returns it', async () => {
    const { service, cacheOf } = fakeDb();
    const product = await service.create(ORG, USER, shirt({
      // A stray total from an old client is ignored, not added on top.
      inventoryQuantity: 99,
      stock: [{ warehouseId: KOCHI, quantity: 5 }, { warehouseId: MAIN, quantity: 3 }],
    }));

    expect(cacheOf(product.variants[0].id)).toBe(8);
    expect(product.variants[0].inventoryQuantity).toBe(8);
  });

  it('gives a location listed with 0 an empty row and no history entry', async () => {
    const { service, rowsOf, events, cacheOf } = fakeDb();
    const product = await service.create(ORG, USER, shirt({
      stock: [{ warehouseId: KOCHI, quantity: 0 }, { warehouseId: MAIN, quantity: 2 }],
    }));

    expect(rowsOf(product.variants[0].id)).toEqual([
      { warehouseId: KOCHI, available: 0 },
      { warehouseId: MAIN, available: 2 },
    ]);
    expect(events.map((e) => e.warehouseId)).toEqual([MAIN]);
    expect(cacheOf(product.variants[0].id)).toBe(2);
  });

  it('stocks every variant of a multi-variant product at its own quantities', async () => {
    const { service, rowsOf, cacheOf } = fakeDb();
    const product = await service.create(ORG, USER, {
      title: 'Linen shirt',
      options: [{ name: 'Size', values: ['M', 'L'], position: 1 }],
      variants: [
        // Positions out of payload order: stock must follow the variant, not the index.
        { price: 1000, option1: 'M', position: 2, stock: [{ warehouseId: MAIN, quantity: 4 }, { warehouseId: KOCHI, quantity: 1 }] },
        { price: 1000, option1: 'L', position: 1, stock: [{ warehouseId: MAIN, quantity: 0 }, { warehouseId: KOCHI, quantity: 6 }] },
      ],
    } as CreateProductDto);

    const medium = product.variants.find((v) => v.option1 === 'M')!;
    const large = product.variants.find((v) => v.option1 === 'L')!;
    expect(rowsOf(medium.id)).toEqual([{ warehouseId: KOCHI, available: 1 }, { warehouseId: MAIN, available: 4 }]);
    expect(rowsOf(large.id)).toEqual([{ warehouseId: KOCHI, available: 6 }, { warehouseId: MAIN, available: 0 }]);
    expect([cacheOf(medium.id), cacheOf(large.id)]).toEqual([5, 6]);
    expect([medium.inventoryQuantity, large.inventoryQuantity]).toEqual([5, 6]);
  });

  it('without stock lines, seeds one empty row at the default location as before', async () => {
    const { service, rowsOf, events } = fakeDb();
    const product = await service.create(ORG, USER, shirt({}));

    expect(rowsOf(product.variants[0].id)).toEqual([{ warehouseId: MAIN, available: 0 }]);
    expect(events).toEqual([]);
  });

  it('treats an empty list like no list', async () => {
    const { service, rowsOf } = fakeDb();
    const product = await service.create(ORG, USER, shirt({ stock: [] }));

    expect(rowsOf(product.variants[0].id)).toEqual([{ warehouseId: MAIN, available: 0 }]);
  });

  it('gives a variant that does not track quantity no rows at all', async () => {
    const { service, stockLevels, events } = fakeDb();
    await service.create(ORG, USER, shirt({
      trackQuantity: false,
      stock: [{ warehouseId: KOCHI, quantity: 5 }],
    }));

    expect(stockLevels).toEqual([]);
    expect(events).toEqual([]);
  });

  it('ignores stock lines in a workspace without locations and keeps its single quantity', async () => {
    const { service, db, stockLevels, events, cacheOf } = fakeDb({ warehousing: false });
    const product = await service.create(ORG, USER, shirt({
      inventoryQuantity: 7,
      stock: [{ warehouseId: 'wh_anything', quantity: 5 }],
    }));

    expect(db.warehouse.findMany).not.toHaveBeenCalled();
    expect(stockLevels).toEqual([]);
    expect(cacheOf(product.variants[0].id)).toBe(7);
    expect(events).toEqual([
      expect.objectContaining({ reason: 'initial', changeAmount: 7, quantityAfter: 7 }),
    ]);
    expect(events[0].warehouseId).toBeUndefined();
  });

  describe('refused, with nothing written', () => {
    const refused = async (stock: Array<{ warehouseId: string; quantity: number }>) => {
      const { service, db, stockLevels, events } = fakeDb();
      const error = await service.create(ORG, USER, shirt({ stock })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(db.product.create).not.toHaveBeenCalled();
      expect(stockLevels).toEqual([]);
      expect(events).toEqual([]);
      return (error as BadRequestException).message;
    };

    it('a location of another workspace', async () => {
      expect(await refused([{ warehouseId: MAIN, quantity: 1 }, { warehouseId: 'wh_other_org', quantity: 2 }]))
        .toBe('One of the stock locations is not a location of this workspace.');
    });

    it('a location that does not exist', async () => {
      expect(await refused([{ warehouseId: 'wh_missing', quantity: 2 }]))
        .toBe('One of the stock locations is not a location of this workspace.');
    });

    it('an inactive location', async () => {
      expect(await refused([{ warehouseId: CLOSED, quantity: 2 }]))
        .toBe('Old godown is inactive. Choose an active location for this stock.');
    });

    it('the same location twice for one variant', async () => {
      expect(await refused([{ warehouseId: KOCHI, quantity: 2 }, { warehouseId: KOCHI, quantity: 3 }]))
        .toBe('Kochi store is listed more than once for the same variant. Give each location one quantity.');
    });
  });
});

describe('ProductService.createVariant — opening stock per location', () => {
  it('stocks the new variant at the chosen locations, like a new product', async () => {
    const { service, rowsOf, events, cacheOf } = fakeDb();
    const variant = await service.createVariant('p_existing', ORG, {
      price: 1000,
      option1: 'XL',
      stock: [{ warehouseId: KOCHI, quantity: 4 }, { warehouseId: MAIN, quantity: 0 }],
    });

    expect(rowsOf(variant.id)).toEqual([{ warehouseId: KOCHI, available: 4 }, { warehouseId: MAIN, available: 0 }]);
    expect(events).toEqual([
      expect.objectContaining({ warehouseId: KOCHI, reason: 'initial', changeAmount: 4, referenceType: 'variant', referenceId: variant.id }),
    ]);
    expect(cacheOf(variant.id)).toBe(4);
    expect(variant.inventoryQuantity).toBe(4);
  });

  it('without stock lines, seeds the default location as before', async () => {
    const { service, rowsOf } = fakeDb();
    const variant = await service.createVariant('p_existing', ORG, { price: 1000, option1: 'XL' });

    expect(rowsOf(variant.id)).toEqual([{ warehouseId: MAIN, available: 0 }]);
  });

  it('refuses an inactive location', async () => {
    const { service, db } = fakeDb();
    await expect(
      service.createVariant('p_existing', ORG, { price: 1000, stock: [{ warehouseId: CLOSED, quantity: 1 }] }),
    ).rejects.toThrow('Old godown is inactive. Choose an active location for this stock.');
    expect(db.productVariant.create).not.toHaveBeenCalled();
  });
});

describe('CreateProductDto — opening stock lines', () => {
  const errorsFor = async (stock: unknown) => {
    const dto = plainToInstance(CreateProductDto, { title: 'Linen shirt', variant: { price: 1, stock } });
    const messages: string[] = [];
    const walk = (errors: Awaited<ReturnType<typeof validate>>) => {
      for (const e of errors) {
        messages.push(...Object.values(e.constraints ?? {}));
        walk(e.children ?? []);
      }
    };
    walk(await validate(dto, { whitelist: true, forbidNonWhitelisted: true }));
    return messages;
  };

  it('accepts whole quantities of 0 or more', async () => {
    expect(await errorsFor([{ warehouseId: MAIN, quantity: 0 }, { warehouseId: KOCHI, quantity: 12 }])).toEqual([]);
  });

  it('refuses a negative quantity, in a sentence', async () => {
    expect(await errorsFor([{ warehouseId: MAIN, quantity: -1 }])).toEqual([
      'Stock at a location cannot be less than 0.',
    ]);
  });

  it('refuses a fractional quantity, in a sentence', async () => {
    expect(await errorsFor([{ warehouseId: MAIN, quantity: 1.5 }])).toEqual([
      'Stock at a location must be a whole number.',
    ]);
  });

  it('refuses a line without a location, in a sentence', async () => {
    expect(await errorsFor([{ warehouseId: '', quantity: 1 }])).toEqual([
      'Choose a location for each stock line.',
    ]);
  });
});
