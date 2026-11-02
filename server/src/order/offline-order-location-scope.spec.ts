import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

/**
 * The order form takes stock from the location it sells from, so a
 * store-limited member (auth/location-scope.util) sells from their own
 * locations only. The orders list itself is not limited.
 */
describe('selling from the order form', () => {
  const user = (role: UserRole) => ({ sub: 'u1', orgId: 'org_1', role });
  const check = (scope: string[], role: UserRole, warehouseId?: string): Promise<void> =>
    OrderService.prototype.assertSaleLocation.call(
      { prisma: { organizationMember: { findUnique: jest.fn(() => Promise.resolve({ locationScope: scope })) } } },
      user(role),
      warehouseId,
    ) as Promise<void>;

  it('is refused from a location outside their list, or from none, which means the default', async () => {
    await expect(check(['st_ko'], UserRole.AGENT, 'st_mg')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(check(['st_ko'], UserRole.MANAGER)).rejects.toThrow('You can only sell from the locations you work at.');
  });

  it('is allowed from their own location, and from anywhere for those who work everywhere', async () => {
    await expect(check(['st_ko'], UserRole.AGENT, 'st_ko')).resolves.toBeUndefined();
    await expect(check([], UserRole.AGENT)).resolves.toBeUndefined();
    await expect(check(['st_ko'], UserRole.ADMIN, 'st_mg')).resolves.toBeUndefined();
  });

  it('makes no order when refused', async () => {
    const orders = {
      assertSaleLocation: jest.fn(() => Promise.reject(new ForbiddenException('no'))),
      createOfflineOrder: jest.fn(),
    };
    const controller = new OrderController(orders as never, {} as never);
    await expect(controller.createOffline(user(UserRole.AGENT) as never, { warehouseId: 'st_mg' } as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(orders.assertSaleLocation).toHaveBeenCalledWith(user(UserRole.AGENT), 'st_mg');
    expect(orders.createOfflineOrder).not.toHaveBeenCalled();
  });
});
