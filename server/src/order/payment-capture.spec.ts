import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChannelPlatform, OrderFinancialStatus } from '@prisma/client';
import { OrderService } from './order.service';
import { CapturePaymentDto } from './dto/capture-payment.dto';
import {
  ORDER_CAPTURABLE_TRANSACTIONS_QUERY,
  ORDER_CAPTURE_MUTATION,
} from '../channel/shopify-graphql.types';

/**
 * Capturing an authorized Shopify payment. The order is only PAID, and only
 * invoiced, when Shopify says the capture succeeded and the order is fully
 * paid. The ceiling is what Shopify still holds on the authorization, in the
 * customer's (presentment) currency.
 */

const ORG = 'org_1';
const ORDER = 'order_1';

// Authorised 100 USD (8,300 INR in shop money); 40 USD already captured.
function build(opts: {
  displayFinancialStatus?: string | null;
  captureStatus?: string;
  unsettled?: { amount: string; currencyCode: string } | null;
} = {}) {
  const authTx = {
    id: 'gid://shopify/OrderTransaction/1', kind: 'AUTHORIZATION', status: 'SUCCESS',
    amountSet: {
      shopMoney: { amount: '8300.00', currencyCode: 'INR' },
      presentmentMoney: { amount: '100.00', currencyCode: 'USD' },
    },
    totalUnsettledSet: opts.unsettled === null ? null : {
      shopMoney: { amount: '4980.00', currencyCode: 'INR' },
      presentmentMoney: opts.unsettled ?? { amount: '60.00', currencyCode: 'USD' },
    },
  };
  const graphql = {
    request: jest.fn()
      .mockResolvedValueOnce({ order: { id: 'gid://shopify/Order/999', transactions: [authTx] } })
      .mockResolvedValueOnce({
        orderCapture: {
          userErrors: [],
          transaction: {
            id: 'gid://shopify/OrderTransaction/2', kind: 'CAPTURE',
            status: opts.captureStatus ?? 'SUCCESS',
            amountSet: { shopMoney: { amount: '0', currencyCode: 'INR' } },
            order: { displayFinancialStatus: opts.displayFinancialStatus === undefined ? 'PAID' : opts.displayFinancialStatus },
          },
        },
      }),
  };
  const tx = {
    order: { update: jest.fn(async ({ data }: any) => ({ id: ORDER, ...data })) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORDER, externalId: '999', organizationId: ORG,
        financialStatus: OrderFinancialStatus.PARTIALLY_PAID,
        channel: { id: 'ch_1', platform: ChannelPlatform.SHOPIFY },
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const invoices = { autoInvoiceForPaidOrder: jest.fn().mockResolvedValue(undefined) };
  const oauth = {
    getAccessToken: jest.fn().mockResolvedValue({ token: 'test-only', shopDomain: 'example.myshopify.com' }),
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, invoices as any, {} as any, {} as any,
    graphql as any, oauth as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, { order: jest.fn() } as any /* commerceEvents */,
  );
  const captureInput = () => graphql.request.mock.calls[1][2].input;
  return { service, prisma, tx, graphql, invoices, captureInput };
}

describe('capture — what is recorded', () => {
  it('keeps a partial capture PARTIALLY_PAID and issues no invoice', async () => {
    const { service, tx, invoices } = build({ displayFinancialStatus: 'PARTIALLY_PAID' });

    await service.capture(ORDER, ORG, 'u1', { amount: 20 });

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: ORDER },
      data: { financialStatus: OrderFinancialStatus.PARTIALLY_PAID },
    });
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
  });

  it('marks PAID and invoices once when the capture completes payment', async () => {
    const { service, tx, invoices } = build({ displayFinancialStatus: 'PAID' });

    await service.capture(ORDER, ORG, 'u1', {});

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: ORDER },
      data: { financialStatus: OrderFinancialStatus.PAID },
    });
    expect(invoices.autoInvoiceForPaidOrder).toHaveBeenCalledTimes(1);
    expect(invoices.autoInvoiceForPaidOrder).toHaveBeenCalledWith(ORG, ORDER);
  });

  it('records a pending capture as pending, keeps Shopify\'s status, and does not invoice', async () => {
    const { service, tx, invoices } = build({
      captureStatus: 'PENDING', displayFinancialStatus: 'PARTIALLY_PAID',
    });

    await service.capture(ORDER, ORG, 'u1', { amount: 20 });

    expect(tx.order.update.mock.calls[0][0].data.financialStatus)
      .toBe(OrderFinancialStatus.PARTIALLY_PAID);
    const event = tx.orderTimelineEvent.create.mock.calls[0][0].data;
    expect(event.action).toBe('capture_pending');
    expect(event.metadata.captureStatus).toBe('PENDING');
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
  });

  it('does not invoice a pending capture even if Shopify already reads PAID', async () => {
    const { service, invoices } = build({ captureStatus: 'PENDING', displayFinancialStatus: 'PAID' });

    await service.capture(ORDER, ORG, 'u1', {});

    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
  });

  it.each(['FAILURE', 'ERROR'])('records nothing when the capture comes back %s', async (status) => {
    const { service, prisma, invoices } = build({ captureStatus: status, displayFinancialStatus: 'PARTIALLY_PAID' });

    await expect(service.capture(ORDER, ORG, 'u1', { amount: 20 })).rejects.toThrow('did not capture');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
  });

  it('keeps the local status when Shopify reports one this app has no value for', async () => {
    const { service, tx, invoices } = build({ displayFinancialStatus: 'EXPIRED' });

    await service.capture(ORDER, ORG, 'u1', { amount: 20 });

    expect(tx.order.update.mock.calls[0][0].data.financialStatus)
      .toBe(OrderFinancialStatus.PARTIALLY_PAID);
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
  });
});

describe('capture — the ceiling and the currency', () => {
  it('defaults to the remaining balance, in the presentment currency', async () => {
    const { service, captureInput } = build();

    await service.capture(ORDER, ORG, 'u1', {});

    expect(captureInput()).toMatchObject({ amount: '60.00', currency: 'USD' });
  });

  it('allows exactly the remaining balance', async () => {
    const { service, captureInput } = build();

    await service.capture(ORDER, ORG, 'u1', { amount: 60, currency: 'usd' });

    expect(captureInput()).toMatchObject({ amount: '60.00', currency: 'USD' });
  });

  it.each([
    ['more than remains, though less than was authorised', { amount: 70 }],
    ['the shop currency instead of the presentment currency', { amount: 20, currency: 'INR' }],
  ])('rejects %s before calling the capture mutation', async (_label, dto) => {
    const { service, graphql, prisma } = build();

    await expect(service.capture(ORDER, ORG, 'u1', dto)).rejects.toThrow();
    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when Shopify reports nothing left to capture', async () => {
    const { service, graphql } = build({ unsettled: null });

    await expect(service.capture(ORDER, ORG, 'u1', {})).rejects.toThrow('nothing left to capture');
    expect(graphql.request).toHaveBeenCalledTimes(1);
  });

  it('asks Shopify for the unsettled balance and the post-capture status', () => {
    expect(ORDER_CAPTURABLE_TRANSACTIONS_QUERY).toMatch(
      /totalUnsettledSet\s*{.*presentmentMoney\s*{\s*amount\s+currencyCode\s*}/,
    );
    expect(ORDER_CAPTURE_MUTATION).toMatch(/order\s*{\s*displayFinancialStatus\s*}/);
  });
});

describe('CapturePaymentDto', () => {
  const errorsFor = async (amount: unknown) =>
    validate(plainToInstance(CapturePaymentDto, { amount }));

  it.each([0, -5, 0.001, 10.555])('rejects amount %p', async (amount) => {
    expect(await errorsFor(amount)).not.toHaveLength(0);
  });

  it.each([0.01, 10.5, 10.55, '25.10'])('accepts amount %p', async (amount) => {
    expect(await errorsFor(amount)).toHaveLength(0);
  });
});
