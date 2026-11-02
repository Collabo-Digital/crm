import { BadRequestException } from '@nestjs/common';
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
  /** Merged into the order the service loads. */
  order?: Record<string, unknown>;
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
    order: {
      update: jest.fn(async ({ data }: any) => ({ id: ORDER, ...data })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ id: ORDER, financialStatus: OrderFinancialStatus.PAID })),
    },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORDER, externalId: '999', organizationId: ORG,
        financialStatus: OrderFinancialStatus.PARTIALLY_PAID,
        channel: { id: 'ch_1', platform: ChannelPlatform.SHOPIFY },
        ...opts.order,
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const invoices = { autoInvoiceForPaidOrder: jest.fn().mockResolvedValue(undefined) };
  const oauth = {
    getAccessToken: jest.fn().mockResolvedValue({ token: 'test-only', shopDomain: 'example.myshopify.com' }),
  };
  const commerceEvents = { order: jest.fn(() => Promise.resolve(undefined)) };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, invoices as any, {} as any, {} as any,
    graphql as any, oauth as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, commerceEvents as never,
  );
  const captureInput = () => graphql.request.mock.calls[1][2].input;
  return { service, prisma, tx, graphql, invoices, captureInput, commerceEvents };
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

/**
 * Marking an order paid fires the 'paid' automations and, with auto-invoicing
 * on, issues an invoice the GST return counts, so it is refused on an order
 * that is over, and happens once however many clicks race to it.
 */
describe('markPaid', () => {
  const unpaidManualOrder = (over: Record<string, unknown> = {}) => ({
    externalId: 'manual_1',
    financialStatus: OrderFinancialStatus.PENDING,
    cancelledAt: null,
    channel: { id: 'ch_manual', platform: ChannelPlatform.MANUAL },
    ...over,
  });

  it('refuses a cancelled order, and nothing follows', async () => {
    const { service, prisma, invoices, commerceEvents } = build({
      order: unpaidManualOrder({ cancelledAt: new Date('2026-10-30T10:00:00Z') }),
    });

    const refusal = service.markPaid(ORDER, ORG, 'u1');

    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow('Cannot mark a cancelled order as paid.');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
    expect(commerceEvents.order).not.toHaveBeenCalled();
  });

  it.each([OrderFinancialStatus.REFUNDED, OrderFinancialStatus.VOIDED])('refuses a %s order', async (financialStatus) => {
    const { service, prisma } = build({ order: unpaidManualOrder({ financialStatus }) });

    await expect(service.markPaid(ORDER, ORG, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks an open, unpaid order paid, and invoices it', async () => {
    const { service, tx, invoices, commerceEvents } = build({ order: unpaidManualOrder() });

    await service.markPaid(ORDER, ORG, 'u1');

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: ORDER,
        organizationId: ORG,
        cancelledAt: null,
        financialStatus: {
          notIn: [OrderFinancialStatus.PAID, OrderFinancialStatus.REFUNDED, OrderFinancialStatus.VOIDED],
        },
      },
      data: { financialStatus: OrderFinancialStatus.PAID },
    });
    expect(invoices.autoInvoiceForPaidOrder).toHaveBeenCalledWith(ORG, ORDER);
    expect(commerceEvents.order).toHaveBeenCalledWith(ORDER, ['paid']);
  });

  it('refuses the loser of two racing clicks, which raises no second paid', async () => {
    const { service, tx, invoices, commerceEvents } = build({ order: unpaidManualOrder() });
    tx.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.markPaid(ORDER, ORG, 'u1')).rejects.toThrow('Order is already paid');
    expect(tx.orderTimelineEvent.create).not.toHaveBeenCalled();
    expect(invoices.autoInvoiceForPaidOrder).not.toHaveBeenCalled();
    expect(commerceEvents.order).not.toHaveBeenCalled();
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
