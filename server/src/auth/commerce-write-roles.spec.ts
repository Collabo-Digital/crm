import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from './decorators/roles.decorator';
import { ALLOW_VENDOR_KEY } from './decorators/allow-vendor.decorator';
import { ProductController } from '../product/product.controller';
import { CustomerController } from '../customer/customer.controller';
import { OrganizationSettingsController } from '../organization-settings/organization-settings.controller';
import { ChannelController } from '../channel/channel.controller';

/**
 * RolesGuard is allow-by-default, so a write route that forgets `@Roles` is
 * open to a read-only VIEWER. These controllers once had exactly that hole:
 * a VIEWER could delete the catalogue, push it to Shopify, rewrite customer
 * GSTINs and turn on product auto-sync. This reads the REAL decorator metadata
 * so a new write route without a role group fails here.
 */
function writeHandlers(cls: any): Array<[string, (...a: any[]) => any]> {
  const proto = cls.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => [name, proto[name]] as [string, (...a: any[]) => any])
    .filter(([, fn]) => {
      const method = Reflect.getMetadata(METHOD_METADATA, fn);
      return method !== undefined && method !== RequestMethod.GET;
    });
}

describe('write routes on commerce controllers declare a role group', () => {
  const controllers = [ProductController, CustomerController, OrganizationSettingsController];

  for (const cls of controllers) {
    describe(cls.name, () => {
      const handlers = writeHandlers(cls);

      it('has write routes to check', () => {
        expect(handlers.length).toBeGreaterThan(0);
      });

      it.each(handlers)('%s refuses VIEWER', (_name, fn) => {
        const roles: UserRole[] | undefined = Reflect.getMetadata(ROLES_KEY, fn);
        expect(roles?.length).toBeGreaterThan(0);
        expect(roles).not.toContain(UserRole.VIEWER);
      });

      it.each(handlers)('%s keeps vendors in when it allows them', (_name, fn) => {
        if (!Reflect.getMetadata(ALLOW_VENDOR_KEY, fn)) return;
        expect(Reflect.getMetadata(ROLES_KEY, fn)).toContain(UserRole.VENDOR);
      });
    });
  }

  it('channel sync is refused to VIEWER', () => {
    const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, ChannelController.prototype.triggerSync);
    expect(roles).toContain(UserRole.AGENT);
    expect(roles).not.toContain(UserRole.VIEWER);
  });

  it('only managers may hard-delete products or import a CSV', () => {
    for (const fn of [
      ProductController.prototype.bulkDelete,
      ProductController.prototype.softDelete,
      ProductController.prototype.startImport,
      ProductController.prototype.confirmImport,
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, fn)).not.toContain(UserRole.AGENT);
    }
  });
});

describe('CustomerController.update GST fields', () => {
  const service = { update: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const controller = new CustomerController(service as any);
  const user = (role: UserRole) => ({ sub: 'u1', email: 'a@b.c', orgId: 'o1', role });

  beforeEach(() => service.update.mockClear());

  it('lets an agent edit tags', async () => {
    await controller.update('c1', user(UserRole.AGENT), { tags: ['vip'] });
    expect(service.update).toHaveBeenCalled();
  });

  it.each([
    { gstin: '27AAPFU0939F1ZV' },
    { billingStateCode: '27' },
    { billingStateName: 'Maharashtra' },
  ])('refuses an agent changing %o', (dto) => {
    expect(() => controller.update('c1', user(UserRole.AGENT), dto)).toThrow(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('lets a manager change the GSTIN', async () => {
    await controller.update('c1', user(UserRole.MANAGER), { gstin: '27AAPFU0939F1ZV' });
    expect(service.update).toHaveBeenCalled();
  });
});
