import { UserRole } from '@prisma/client';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

const row = (userId: string, role: UserRole, email: string) => ({
  id: `m_${userId}`,
  userId,
  role,
  permissions: { grants: ['section.chat'] },
  joinedAt: new Date('2026-10-01'),
  user: { id: userId, email, firstName: userId, lastName: 'X', avatarUrl: null, lastLoginAt: new Date('2026-10-27') },
});

function build() {
  const prisma = {
    organizationMember: {
      findMany: jest.fn(() =>
        Promise.resolve([
          row('owner', UserRole.OWNER, 'owner@test.local'),
          row('agent', UserRole.AGENT, 'agent@test.local'),
          row('agent2', UserRole.AGENT, 'agent2@test.local'),
        ]),
      ),
    },
  };
  const service = new MembersService(prisma as never, {} as never, {} as never, {} as never);
  return { service };
}

describe('Settings › Team members — what each role sees', () => {
  it("shows an agent the roster and their own row, without teammates' emails, sign-ins or access", async () => {
    const { service } = build();

    const list = await service.findAll('org', { userId: 'agent', role: UserRole.AGENT });

    const others = list.filter((m) => m.user.id !== 'agent');
    expect(others).toHaveLength(2);
    for (const m of others) {
      expect(m.user).toEqual({ id: m.user.id, firstName: m.user.firstName, lastName: 'X', avatarUrl: null });
      expect(m).not.toHaveProperty('permissions');
      expect(m.role).toBeDefined();
    }
    expect(list.find((m) => m.user.id === 'agent')).toMatchObject({ user: { email: 'agent@test.local' }, permissions: ['section.chat'] });
  });

  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER])('shows a %s every teammate in full', async (role) => {
    const { service } = build();

    const list = await service.findAll('org', { userId: 'someone', role });

    expect(list.map((m) => 'email' in m.user && m.user.email)).toEqual(['owner@test.local', 'agent@test.local', 'agent2@test.local']);
    for (const m of list) expect(m.user).toHaveProperty('lastLoginAt');
  });

  it("decides by the caller's role in the workspace", async () => {
    const members = { findAll: jest.fn(() => Promise.resolve([])) };
    const orgs = { requireRole: jest.fn(() => Promise.resolve({ role: UserRole.VIEWER })) };
    const controller = new MembersController(members as never, orgs as never);

    await controller.findAll('org', { sub: 'u1', email: 'v@test.local' });

    expect(members.findAll).toHaveBeenCalledWith('org', { userId: 'u1', role: UserRole.VIEWER });
  });
});
