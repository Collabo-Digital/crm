import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { GstController } from '../../gst/gst.controller';
import { InwardSupplyController } from '../../inward-supply/inward-supply.controller';
import { OrganizationSettingsController } from '../../organization-settings/organization-settings.controller';
import { SectionAccessGuard } from './section-access.guard';

/** The guard's answer for one route, read from the controller's own decorators. */
function allowed(controller: abstract new (...args: never[]) => unknown, handler: string, role: UserRole, grants: string[]): boolean {
  const context = {
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, permissions: grants } }) }),
  } as unknown as ExecutionContext;
  try {
    return new SectionAccessGuard(new Reflector()).canActivate(context);
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

const routes = {
  gstins: [GstController, 'findAllGstins'],
  taxRates: [GstController, 'findAllStateTaxRates'],
  states: [GstController, 'getStates'],
  settings: [OrganizationSettingsController, 'getAll'],
  paymentFees: [InwardSupplyController, 'list'],
} as const;

const check = (route: keyof typeof routes, role: UserRole, grants: string[]) => allowed(routes[route][0], routes[route][1], role, grants);

describe('GST registrations, workspace settings and payment fees — who may read them', () => {
  const chatOnly = ['section.chat', 'chat.view_unassigned'];

  it('refuses a member kept to Chat', () => {
    expect(check('gstins', UserRole.AGENT, chatOnly)).toBe(false);
    expect(check('taxRates', UserRole.AGENT, chatOnly)).toBe(false);
    expect(check('settings', UserRole.AGENT, chatOnly)).toBe(false);
    expect(check('paymentFees', UserRole.AGENT, chatOnly)).toBe(false);
    expect(check('settings', UserRole.VIEWER, ['section.campaigns', 'campaigns.view'])).toBe(false);
  });

  it('keeps the list of states open to every member, for address forms', () => {
    expect(check('states', UserRole.AGENT, chatOnly)).toBe(true);
  });

  it('lets the sections whose screens read them through', () => {
    for (const section of ['section.orders', 'section.products', 'section.invoices']) {
      expect(check('gstins', UserRole.AGENT, [section])).toBe(true);
      expect(check('settings', UserRole.VIEWER, [section])).toBe(true);
    }
    // The Packer preset's grants; the payment fees belong to the GST return, on Invoices.
    expect(check('settings', UserRole.AGENT, ['section.products', 'inventory.view', 'inventory.pack'])).toBe(true);
    expect(check('paymentFees', UserRole.AGENT, ['section.invoices'])).toBe(true);
    expect(check('paymentFees', UserRole.AGENT, ['section.orders'])).toBe(false);
  });

  it('leaves owners, managers and members who joined before section access alone', () => {
    for (const route of Object.keys(routes) as Array<keyof typeof routes>) {
      expect(check(route, UserRole.OWNER, [])).toBe(true);
      expect(check(route, UserRole.MANAGER, [])).toBe(true);
      expect(check(route, UserRole.AGENT, [])).toBe(true);
    }
  });
});
