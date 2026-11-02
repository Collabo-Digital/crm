import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { VendorAccessGuard } from './guards/vendor-access.guard';
import { OrderController } from '../order/order.controller';
import { ProductController } from '../product/product.controller';

/**
 * The stats routes used to be the one hole in the vendor surface: VENDOR is
 * deny-by-default, and both `@Get('stats')` handlers were missing
 * `@AllowVendor()`, so a vendor's tiles were four em-dashes over a full table.
 *
 * This runs the REAL guard against the REAL decorator metadata on the REAL
 * controller classes, so deleting `@AllowVendor()` from either route fails here
 * rather than silently blanking the vendor dashboard again.
 */

const guard = new VendorAccessGuard(new Reflector());

function ctx(handler: (...a: any[]) => any, cls: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as any;
}

const vendor = {
  role: UserRole.VENDOR,
  vendorScope: 'collabo-test',
  sub: 'u1',
  orgId: 'o1',
};

describe('VendorAccessGuard on the stats routes', () => {
  const routes: Array<[string, (...a: any[]) => any, any]> = [
    ['OrderController.getStats', OrderController.prototype.getStats, OrderController],
    ['ProductController.getStats', ProductController.prototype.getStats, ProductController],
    [
      'ProductController.getProductTypes',
      ProductController.prototype.getProductTypes,
      ProductController,
    ],
  ];

  it.each(routes)('admits a scoped vendor to %s', (_name, handler, cls) => {
    expect(guard.canActivate(ctx(handler, cls, vendor))).toBe(true);
  });

  it.each(routes)('still refuses a vendor with no scope on %s', (_name, handler, cls) => {
    expect(() =>
      guard.canActivate(ctx(handler, cls, { ...vendor, vendorScope: undefined })),
    ).toThrow(ForbiddenException);
  });

  // Guards against a vacuous suite: if @AllowVendor() had leaked onto the whole
  // controller, every route would pass and the tests above would prove nothing.
  it('still refuses a vendor on a route that was never opened to them', () => {
    expect(() =>
      guard.canActivate(
        ctx(OrderController.prototype.createOffline, OrderController, vendor),
      ),
    ).toThrow('Vendors cannot access this resource.');
  });

  it('leaves non-vendor roles alone', () => {
    expect(
      guard.canActivate(
        ctx(OrderController.prototype.createOffline, OrderController, {
          role: UserRole.OWNER,
        }),
      ),
    ).toBe(true);
  });
});

describe('stats controllers route by role', () => {
  it('sends a vendor to the vendor comparison, carrying their scope', () => {
    const orderService = {
      getComparison: jest.fn(),
      getVendorComparison: jest.fn().mockReturnValue('vendor-stats'),
    };
    const c = new OrderController(orderService as any, {} as never);

    const out = c.getStats(vendor as any, {} as any);

    expect(out).toBe('vendor-stats');
    expect(orderService.getVendorComparison).toHaveBeenCalledWith(
      'o1',
      {},
      'collabo-test',
    );
    expect(orderService.getComparison).not.toHaveBeenCalled();
  });

  it('leaves an owner on the org-wide comparison', () => {
    const orderService = {
      getComparison: jest.fn().mockReturnValue('org-stats'),
      getVendorComparison: jest.fn(),
    };
    const c = new OrderController(orderService as any, {} as never);

    const out = c.getStats({ role: UserRole.OWNER, orgId: 'o1' } as any, {} as any);

    expect(out).toBe('org-stats');
    expect(orderService.getVendorComparison).not.toHaveBeenCalled();
  });

  it('passes the vendor scope into product stats and types', () => {
    const productService = { getStats: jest.fn(), getProductTypes: jest.fn() };
    const c = new ProductController(productService as any);

    c.getStats(vendor as any, undefined);
    c.getProductTypes(vendor as any);

    expect(productService.getStats).toHaveBeenCalledWith('o1', undefined, 'collabo-test');
    expect(productService.getProductTypes).toHaveBeenCalledWith('o1', 'collabo-test');
  });

  it('passes no scope for an owner', () => {
    const productService = { getStats: jest.fn(), getProductTypes: jest.fn() };
    const c = new ProductController(productService as any);
    const owner = { role: UserRole.OWNER, orgId: 'o1' } as any;

    c.getStats(owner, undefined);
    c.getProductTypes(owner);

    expect(productService.getStats).toHaveBeenCalledWith('o1', undefined, undefined);
    expect(productService.getProductTypes).toHaveBeenCalledWith('o1', undefined);
  });
});
