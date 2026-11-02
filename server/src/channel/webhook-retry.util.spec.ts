import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/library';
import { RateLimitedError } from '../rate-limit/rate-limit.types';
import { ShopifyGraphqlError } from './shopify-graphql.client';
import { isTransientWebhookError } from './webhook-retry.util';

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });
}

describe('isTransientWebhookError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'])(
    'asks Shopify to retry after %s',
    (code) => {
      expect(isTransientWebhookError(prismaError(code))).toBe(true);
    },
  );

  it('retries a raw-query serialization failure or deadlock', () => {
    expect(isTransientWebhookError(prismaError('P2010', { code: '40001' }))).toBe(true);
    expect(isTransientWebhookError(prismaError('P2010', { code: '40P01' }))).toBe(true);
    expect(isTransientWebhookError(prismaError('P2010', { code: '23505' }))).toBe(false);
  });

  it('retries when the database cannot be reached at all', () => {
    expect(isTransientWebhookError(new PrismaClientInitializationError('down', 'test'))).toBe(true);
  });

  it('retries Shopify timeouts and 5xx, not auth or query errors', () => {
    expect(isTransientWebhookError(new ShopifyGraphqlError('t', 'TIMEOUT'))).toBe(true);
    expect(isTransientWebhookError(new ShopifyGraphqlError('t', 'HTTP_ERROR', undefined, 502))).toBe(true);
    expect(isTransientWebhookError(new ShopifyGraphqlError('t', 'HTTP_ERROR', undefined, 404))).toBe(false);
    expect(isTransientWebhookError(new ShopifyGraphqlError('t', 'AUTH_FAILED'))).toBe(false);
  });

  it('retries a rate-limited call', () => {
    const scope = { platform: 'shopify', kind: 'bucket', id: 'shop.myshopify.com' } as const;
    expect(isTransientWebhookError(new RateLimitedError(scope as any, Date.now() + 1000, 'BUCKET'))).toBe(true);
  });

  // A payload this code cannot handle fails the same way on every retry, and
  // Shopify deletes a subscription whose deliveries keep failing.
  it('acknowledges everything else', () => {
    expect(isTransientWebhookError(prismaError('P2002'))).toBe(false);
    expect(isTransientWebhookError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientWebhookError('nope')).toBe(false);
  });
});
