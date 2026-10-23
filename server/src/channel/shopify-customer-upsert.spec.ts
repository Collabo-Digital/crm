import { Prisma } from '@prisma/client';
import { ShopifySyncService } from './shopify-sync.service';

/**
 * `upsertCustomer` against Customer's two uniques — (channelId, externalId)
 * and (organizationId, email).
 *
 * It used to upsert on the first and catch the second. That logged a
 * `prisma:error` for every CRM customer echoed back by Shopify, and when the
 * Shopify customer's row already existed but their new email belonged to
 * another row, the fallback re-pointed that other row onto an identity still
 * held — failing a second time, uncaught, so the webhook failed.
 */

const ORG = 'org_1';
const CHANNEL = 'ch_shopify';
const SHOPIFY_ID = 555;

const shopifyCustomer = (over: Record<string, unknown> = {}) => ({
  id: SHOPIFY_ID,
  email: 'ana@example.com',
  first_name: 'Ana',
  last_name: 'Lee',
  phone: null,
  state: 'enabled',
  tags: '',
  created_at: '2026-09-01T00:00:00Z',
  ...over,
});

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/**
 * `identity` / `byEmail` are what the two findUnique lookups return; each can
 * be a sequence to model the race retry re-reading.
 */
function build(opts: {
  identity?: Array<{ id: string } | null>;
  byEmail?: Array<{ id: string } | null>;
  createRejects?: boolean;
}) {
  const identity = [...(opts.identity ?? [null])];
  const byEmail = [...(opts.byEmail ?? [null])];
  const next = <T>(q: T[]) => (q.length > 1 ? q.shift()! : q[0]);

  const prisma = {
    customer: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(where.channelId_externalId ? next(identity) : next(byEmail)),
      ),
      update: jest.fn(({ where }: any) => Promise.resolve({ id: where.id })),
      create: jest.fn((_args: any) =>
        opts.createRejects ? Promise.reject(p2002()) : Promise.resolve({ id: 'new_row' }),
      ),
      upsert: jest.fn(),
    },
  };
  const loyalty = { recomputeForCustomer: jest.fn().mockResolvedValue(undefined) };

  // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
  // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
  const service = new ShopifySyncService(
    prisma as any, {} as any, loyalty as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  return { service, prisma, loyalty, warn };
}

describe('ShopifySyncService.upsertCustomer', () => {
  it('creates a new customer when neither the Shopify id nor the email is on file', async () => {
    const { service, prisma, loyalty } = build({});

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer());

    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.customer.create.mock.calls[0][0] as any;
    expect(data).toMatchObject({
      organizationId: ORG,
      channelId: CHANNEL,
      externalId: String(SHOPIFY_ID),
      email: 'ana@example.com',
    });
    expect(data.externalCreatedAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(loyalty.recomputeForCustomer).toHaveBeenCalledWith('new_row', ORG);
  });

  it('updates the row that already holds this Shopify id', async () => {
    const { service, prisma } = build({ identity: [{ id: 'row_a' }], byEmail: [{ id: 'row_a' }] });

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer({ first_name: 'Anna' }));

    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customer.update).toHaveBeenCalledTimes(1);
    const call = prisma.customer.update.mock.calls[0][0] as any;
    expect(call.where).toEqual({ id: 'row_a' });
    expect(call.data).toMatchObject({ email: 'ana@example.com', firstName: 'Anna' });
  });

  it('adopts a CRM customer with the same email instead of failing on the email unique', async () => {
    const { service, prisma } = build({ identity: [null], byEmail: [{ id: 'crm_row' }] });

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer());

    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customer.upsert).not.toHaveBeenCalled();
    const call = prisma.customer.update.mock.calls[0][0] as any;
    expect(call.where).toEqual({ id: 'crm_row' });
    expect(call.data).toMatchObject({ channelId: CHANNEL, externalId: String(SHOPIFY_ID) });
  });

  it('keeps the current email when the new one belongs to a different customer', async () => {
    const { service, prisma, warn } = build({
      identity: [{ id: 'row_a' }],
      byEmail: [{ id: 'row_b' }],
    });

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer({ first_name: 'Anna' }));

    // Only row_a is touched — row_b is never re-pointed onto row_a's identity.
    expect(prisma.customer.update).toHaveBeenCalledTimes(1);
    const call = prisma.customer.update.mock.calls[0][0] as any;
    expect(call.where).toEqual({ id: 'row_a' });
    expect(call.data).not.toHaveProperty('email');
    expect(call.data).not.toHaveProperty('externalId');
    expect(call.data.firstName).toBe('Anna');
    expect(warn).toHaveBeenCalledTimes(1);
    // Row ids only — the email is PII and stays out of the log.
    expect(warn.mock.calls[0][0]).not.toContain('ana@example.com');
  });

  it('retries once when a concurrent writer inserted the same customer first', async () => {
    const { service, prisma } = build({
      identity: [null, { id: 'raced_row' }],
      byEmail: [null, { id: 'raced_row' }],
      createRejects: true,
    });

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer());

    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    const call = prisma.customer.update.mock.calls[0][0] as any;
    expect(call.where).toEqual({ id: 'raced_row' });
  });

  it('does not look up by email when Shopify sends none', async () => {
    const { service, prisma } = build({});

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer({ email: null }));

    expect(prisma.customer.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
  });
});

describe('ShopifySyncService.upsertCustomer — Shopify must not blank the CRM name', () => {
  // What Shopify sends back for a customer it created from a pushed draft or
  // order: the CRM sent only the email, so Shopify has no name.
  const nameless = () => shopifyCustomer({ first_name: null, last_name: null, phone: null, note: null });

  it('adopting a CRM customer keeps the name the merchant typed', async () => {
    const { service, prisma } = build({ identity: [null], byEmail: [{ id: 'crm_row' }] });

    await service.upsertCustomer(CHANNEL, ORG, nameless());

    const { data } = prisma.customer.update.mock.calls[0][0] as any;
    expect(data).toMatchObject({ channelId: CHANNEL, externalId: String(SHOPIFY_ID) });
    for (const field of ['firstName', 'lastName', 'phone', 'note']) {
      expect(data).not.toHaveProperty(field);
    }
  });

  it('a later update with empty values keeps them too', async () => {
    const { service, prisma } = build({ identity: [{ id: 'row_a' }], byEmail: [{ id: 'row_a' }] });

    await service.upsertCustomer(CHANNEL, ORG, nameless());

    const { data } = prisma.customer.update.mock.calls[0][0] as any;
    expect(data).not.toHaveProperty('firstName');
    expect(data).not.toHaveProperty('lastName');
    expect(data.email).toBe('ana@example.com');
  });

  it('a real rename in Shopify admin still flows through', async () => {
    const { service, prisma } = build({ identity: [{ id: 'row_a' }], byEmail: [{ id: 'row_a' }] });

    await service.upsertCustomer(CHANNEL, ORG, shopifyCustomer({ first_name: 'Anna', last_name: 'Leigh' }));

    const { data } = prisma.customer.update.mock.calls[0][0] as any;
    expect(data).toMatchObject({ firstName: 'Anna', lastName: 'Leigh' });
  });

  it('non-identity fields (marketing consent, state) are still written', async () => {
    const { service, prisma } = build({ identity: [{ id: 'row_a' }], byEmail: [{ id: 'row_a' }] });

    await service.upsertCustomer(CHANNEL, ORG, nameless());

    const { data } = prisma.customer.update.mock.calls[0][0] as any;
    expect(data).toHaveProperty('acceptsMarketing');
    expect(data).toHaveProperty('state');
  });
});
