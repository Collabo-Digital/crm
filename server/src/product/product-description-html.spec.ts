import { CreateProductDto } from './dto/create-product.dto';
import { ProductService } from './product.service';

/**
 * Every API write of a product description goes through the sanitiser. AGENT
 * members, and VENDOR members on their own products, can edit descriptions,
 * and what is stored here is later pushed to the merchant's live store.
 */

const ORG = 'org_1';
const UNSAFE = '<p onclick="steal()">Soft <b>cotton</b></p><script>steal()</script>';
const SAFE = '<p>Soft <b>cotton</b></p>';

class Stop extends Error {}

function build() {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(db)),
    channel: { findFirst: jest.fn(() => Promise.resolve({ id: 'ch_manual' })) },
    product: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          title: 'Shirt',
          vendor: 'Acme',
          bodyHtml: UNSAFE,
          tags: [],
          options: null,
          channel: { platform: 'MANUAL' },
          variants: [],
          images: [],
        }),
      ),
      // Nothing after the write matters here.
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return Promise.reject(new Stop());
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return Promise.resolve({});
      }),
      findUnique: jest.fn(() => Promise.resolve({ metadata: {} })),
    },
  };
  const enqueuer = { enqueueAvailabilityPush: jest.fn(() => Promise.resolve()) };
  const service = new ProductService(
    db as never,
    enqueuer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, writes };
}

describe('ProductService — description HTML on write', () => {
  it('sanitises the description of a new product', async () => {
    const { service, writes } = build();
    const dto = { title: 'Shirt', bodyHtml: UNSAFE, variant: { price: 100 } } as CreateProductDto;
    await expect(service.create(ORG, 'user_1', dto)).rejects.toBeInstanceOf(Stop);
    expect(writes[0].bodyHtml).toBe(SAFE);
  });

  it('sanitises an edited description, including a vendor’s', async () => {
    const { service, writes } = build();
    await service.update('p1', ORG, { bodyHtml: UNSAFE }, 'Acme');
    expect(writes[0]).toEqual({ bodyHtml: SAFE });
  });

  it('still lets an edit clear the description', async () => {
    const { service, writes } = build();
    await service.update('p1', ORG, { bodyHtml: null as unknown as string });
    expect(writes[0]).toEqual({ bodyHtml: null });
  });

  it('sanitises the description a duplicate copies from an older row', async () => {
    const { service, writes } = build();
    await expect(service.duplicate('p1', ORG)).rejects.toBeInstanceOf(Stop);
    expect(writes[0].bodyHtml).toBe(SAFE);
  });
});
