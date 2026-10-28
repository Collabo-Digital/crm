import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { setupProgress, type SetupFacts } from './setup-progress';

const ORG = 'org_1';

const NOTHING: SetupFacts = {
  whatsappChannels: 0,
  shopifyChannels: 0,
  products: 0,
  storeProfileSettings: null,
  gstEnabled: false,
  gstinAddresses: [],
  members: 1,
  pendingInvites: 0,
  recommendedAutomationsOn: 0,
};

const facts = (over: Partial<SetupFacts>): SetupFacts => ({ ...NOTHING, ...over });

describe('setupProgress', () => {
  it('has nothing done for a workspace that was just created', () => {
    expect(setupProgress(NOTHING)).toEqual({
      whatsapp: false,
      catalogue: false,
      storeProfile: false,
      gst: false,
      team: false,
      automations: false,
    });
  });

  it('counts a connected WhatsApp number', () => {
    expect(setupProgress(facts({ whatsappChannels: 1 })).whatsapp).toBe(true);
  });

  it('counts products, or a Shopify store that will bring them in', () => {
    expect(setupProgress(facts({ products: 3 })).catalogue).toBe(true);
    expect(setupProgress(facts({ shopifyChannels: 1 })).catalogue).toBe(true);
  });

  it('needs a number and an address for the store profile', () => {
    const phoneOnly = { supportPhone: '+91 98111 00089' };
    const withAddress = { ...phoneOnly, address1: '12 MG Road', city: 'Pune' };
    expect(setupProgress(facts({ storeProfileSettings: phoneOnly })).storeProfile).toBe(false);
    expect(setupProgress(facts({ storeProfileSettings: { address1: '12 MG Road', city: 'Pune' } })).storeProfile).toBe(false);
    expect(setupProgress(facts({ storeProfileSettings: withAddress })).storeProfile).toBe(true);
    expect(setupProgress(facts({ storeProfileSettings: { whatsappPhone: '+91 98111 00089', city: 'Pune' } })).storeProfile).toBe(true);
  });

  it("takes the address from a GSTIN when the profile has none, as the slip does", () => {
    const phoneOnly = { supportPhone: '+91 98111 00089' };
    expect(
      setupProgress(facts({ storeProfileSettings: phoneOnly, gstinAddresses: [{ address1: '4 Park St', city: 'Kolkata' }] })).storeProfile,
    ).toBe(true);
    expect(setupProgress(facts({ storeProfileSettings: phoneOnly, gstinAddresses: [{}] })).storeProfile).toBe(false);
  });

  it('needs GST switched on and a GSTIN', () => {
    expect(setupProgress(facts({ gstEnabled: true })).gst).toBe(false);
    expect(setupProgress(facts({ gstinAddresses: [null] })).gst).toBe(false);
    expect(setupProgress(facts({ gstEnabled: true, gstinAddresses: [null] })).gst).toBe(true);
  });

  it('counts the team once someone else has joined or been invited', () => {
    expect(setupProgress(facts({ members: 1 })).team).toBe(false);
    expect(setupProgress(facts({ members: 2 })).team).toBe(true);
    expect(setupProgress(facts({ pendingInvites: 1 })).team).toBe(true);
  });

  it('counts a recommended automation that is on', () => {
    expect(setupProgress(facts({ recommendedAutomationsOn: 1 })).automations).toBe(true);
  });

  it('reads a corrupt store profile as empty rather than failing', () => {
    expect(setupProgress(facts({ storeProfileSettings: 'not an object' })).storeProfile).toBe(false);
  });
});

describe('DashboardService.getSetupProgress', () => {
  function build() {
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: true }) },
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue({
          storeProfileSettings: { supportPhone: '+91 98111 00089', address1: '12 MG Road', city: 'Pune' },
        }),
      },
      channel: { count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0) },
      product: { count: jest.fn().mockResolvedValue(12) },
      organizationGstin: { findMany: jest.fn().mockResolvedValue([{ address: null }]) },
      organizationMember: { count: jest.fn().mockResolvedValue(1) },
      teamInvite: { count: jest.fn().mockResolvedValue(0) },
      automation: { count: jest.fn().mockResolvedValue(2) },
    };
    return { prisma, service: new DashboardService(prisma as any) };
  }

  it('answers from the workspace data', async () => {
    const { service } = build();
    await expect(service.getSetupProgress(ORG)).resolves.toEqual({
      whatsapp: true,
      catalogue: true,
      storeProfile: true,
      gst: true,
      team: false,
      automations: true,
    });
  });

  it('reads only this workspace', async () => {
    const { prisma, service } = build();
    await service.getSetupProgress(ORG);
    expect(prisma.organization.findUnique.mock.calls[0][0].where).toEqual({ id: ORG });
    for (const query of [
      prisma.organizationSettings.findUnique,
      prisma.channel.count,
      prisma.product.count,
      prisma.organizationGstin.findMany,
      prisma.organizationMember.count,
      prisma.teamInvite.count,
      prisma.automation.count,
    ]) {
      expect(query.mock.calls[0][0].where.organizationId).toBe(ORG);
    }
  });

  it('counts connected WhatsApp and Shopify channels, and products not deleted', async () => {
    const { prisma, service } = build();
    await service.getSetupProgress(ORG);
    const [whatsapp, shopify] = prisma.channel.count.mock.calls.map((call: any[]) => call[0].where);
    expect(whatsapp).toMatchObject({ platform: 'WHATSAPP', status: { in: ['CONNECTED', 'SYNCING'] } });
    expect(shopify).toMatchObject({ platform: 'SHOPIFY', status: { in: ['CONNECTED', 'SYNCING'] } });
    expect(prisma.product.count.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
  });

  it('leaves influencers and expired invitations out of the team', async () => {
    const { prisma, service } = build();
    await service.getSetupProgress(ORG);
    expect(prisma.organizationMember.count.mock.calls[0][0].where).toMatchObject({
      isActive: true,
      role: { not: 'INFLUENCER' },
    });
    const invites = prisma.teamInvite.count.mock.calls[0][0].where;
    expect(invites).toMatchObject({ status: 'PENDING', role: { not: 'INFLUENCER' } });
    expect(invites.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("counts only the recommended pack's automations that are on", async () => {
    const { prisma, service } = build();
    await service.getSetupProgress(ORG);
    expect(prisma.automation.count.mock.calls[0][0].where).toMatchObject({
      packKey: { not: null },
      archivedAt: null,
      OR: [{ status: 'ACTIVE' }, { activateWhenReady: true }],
    });
  });
});

describe('GET /dashboard/setup', () => {
  it('is for owners and admins', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, DashboardController.prototype.getSetupProgress);
    expect(roles).toEqual([UserRole.OWNER, UserRole.ADMIN]);
  });
});
