import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * A support (impersonation) session must stay one. The `impersonatedBy` marker
 * used to be dropped on the first token refresh or workspace switch, turning
 * the session into an ordinary login of the target user.
 */
describe('AuthService — impersonation survives refresh and workspace switch', () => {
  const ADMIN = 'admin-1';
  const membership = { organizationId: 'org-a', role: 'OWNER', vendorScope: null, permissions: null };

  function build(
    opts: { allowlist?: string[]; adminDeleted?: boolean; adminSessionLive?: boolean; stored?: Record<string, unknown> } = {},
  ) {
    const target = {
      id: 'u1',
      email: 'u1@example.com',
      deletedAt: null,
      emailVerified: true,
      isSuperAdmin: false,
      memberships: [{ ...membership, organization: { id: 'org-a', deletedAt: null } }],
    };
    const admin = {
      id: ADMIN,
      email: 'admin@example.com',
      isSuperAdmin: true,
      emailVerified: true,
      deletedAt: opts.adminDeleted ? new Date() : null,
      memberships: [],
    };
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(where.id === ADMIN ? { ...admin } : target),
          ),
        update: jest.fn().mockResolvedValue(undefined),
      },
      organizationMember: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...membership, isActive: true, organization: { id: 'org-a', deletedAt: null } }),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue(undefined),
      },
      impersonationLog: { updateMany: jest.fn().mockResolvedValue(undefined) },
    };
    const redis = {
      consumeRefreshToken: jest.fn().mockResolvedValue(opts.stored ?? null),
      getRefreshRotation: jest.fn().mockResolvedValue(null),
      setRefreshRotationResult: jest.fn().mockResolvedValue(undefined),
      clearRefreshRotation: jest.fn().mockResolvedValue(undefined),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      trackUserToken: jest.fn().mockResolvedValue(undefined),
      sessionRevision: jest.fn().mockResolvedValue('rev-1'),
      setSession: jest.fn().mockResolvedValue(true),
      setAuthSession: jest.fn().mockResolvedValue(undefined),
      touchAuthSession: jest.fn().mockResolvedValue(true),
      isAuthSessionActive: jest.fn().mockResolvedValue(opts.adminSessionLive ?? true),
      deleteAuthSession: jest.fn().mockResolvedValue(undefined),
    };
    const jwt = { sign: jest.fn().mockReturnValue('access') };
    const allowlist = opts.allowlist ?? ['admin@example.com'];
    const config = { get: jest.fn((key: string) => (key === 'superAdminEmails' ? allowlist : '7d')) };

    const service = new AuthService(
      prisma as never,
      jwt as never,
      config as never,
      {} as never,
      {} as never,
      redis as never,
    );
    return { service, redis, jwt, prisma };
  }

  const impersonating = { userId: 'u1', orgId: 'org-a', sid: 's1', impersonatedBy: ADMIN, impersonatorSid: 'admin-sid' };

  it('stores the marker with the refresh token when impersonation starts', async () => {
    const { service, redis } = build();

    await service.generateTokenPair({
      sub: 'u1',
      email: 'u1@example.com',
      isSuperAdmin: false,
      impersonatedBy: ADMIN,
      impersonatorSid: 'admin-sid',
    });

    expect(redis.setRefreshToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ impersonatedBy: ADMIN, impersonatorSid: 'admin-sid' }),
    );
  });

  it('keeps the marker in the token, refresh token and session cache across a refresh', async () => {
    const { service, redis, jwt } = build({ stored: impersonating });

    await service.rotateRefreshToken('old');

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ impersonatedBy: ADMIN, impersonatorSid: 'admin-sid', isSuperAdmin: false }),
    );
    expect(redis.isAuthSessionActive).toHaveBeenCalledWith('admin-sid', ADMIN);
    expect(redis.setRefreshToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ impersonatedBy: ADMIN, impersonatorSid: 'admin-sid', sid: 's1' }),
    );
    expect(redis.setSession).toHaveBeenCalledWith('u1', expect.objectContaining({ impersonatedBy: ADMIN }), 'rev-1');
  });

  it('ends the session at refresh once the admin is off the super-admin allowlist', async () => {
    const { service, redis, jwt, prisma } = build({ stored: impersonating, allowlist: [] });

    await expect(service.rotateRefreshToken('old')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
    expect(jwt.sign).not.toHaveBeenCalled();
    // The audit row is closed, not left open forever.
    expect(prisma.impersonationLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { superAdminId: ADMIN, targetUserId: 'u1', endedAt: null } }),
    );
  });

  it("ends the session at refresh once the admin's own session was logged out or revoked", async () => {
    const { service, redis, jwt } = build({ stored: impersonating, adminSessionLive: false });

    await expect(service.rotateRefreshToken('old')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('retires the session impersonation was started from when it is stopped', async () => {
    const { service, redis } = build();

    await service.stopImpersonation(ADMIN, { sid: 's1', targetUserId: 'u1', impersonatorSid: 'admin-sid' });

    expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
    expect(redis.deleteAuthSession).toHaveBeenCalledWith('admin-sid', ADMIN);
  });

  describe('stopping', () => {
    const stop = { sid: 's1', targetUserId: 'u1', impersonatorSid: 'admin-sid' };

    it("hands back admin tokens, checking the admin's session before retiring it", async () => {
      const { service, redis, jwt } = build();
      const live = new Set(['s1', 'admin-sid']);
      redis.isAuthSessionActive.mockImplementation((sid: string) => Promise.resolve(live.has(sid)));
      redis.deleteAuthSession.mockImplementation((sid: string) => Promise.resolve(void live.delete(sid)));

      await expect(service.stopImpersonation(ADMIN, stop)).resolves.toMatchObject({ user: { id: ADMIN, isSuperAdmin: true } });
      expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: ADMIN, isSuperAdmin: true }));
    });

    // Otherwise a support session that outlived a forced logout of the admin
    // could be traded for a brand-new admin session.
    it.each([
      ["the admin's own session was logged out or revoked", { adminSessionLive: false }, stop],
      ['the admin is off the super-admin allowlist', { allowlist: [] }, stop],
      ['the support session has no recorded origin', {}, { sid: 's1', targetUserId: 'u1' }],
    ])('issues no admin tokens when %s, but still ends the support session', async (_case, opts, args) => {
      const { service, redis, jwt, prisma } = build(opts);

      await expect(service.stopImpersonation(ADMIN, args)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.sign).not.toHaveBeenCalled();
      expect(redis.setAuthSession).not.toHaveBeenCalled();
      expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
      expect(prisma.impersonationLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { superAdminId: ADMIN, endedAt: null } }),
      );
    });
  });

  it('ends the session at refresh once the admin account is deleted', async () => {
    const { service, redis } = build({ stored: impersonating, adminDeleted: true });

    await expect(service.rotateRefreshToken('old')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
  });

  it('does not add a marker to an ordinary refresh', async () => {
    const { service, jwt } = build({ stored: { userId: 'u1', orgId: 'org-a', sid: 's1' } });

    await service.rotateRefreshToken('old');

    const [signed] = jwt.sign.mock.calls[0] as [Record<string, unknown>];
    expect(signed).not.toHaveProperty('impersonatedBy');
  });

  it('keeps the marker when switching workspace', async () => {
    const { service, redis, jwt } = build();

    await service.switchOrg('u1', 'org-a', 's1', { impersonatedBy: ADMIN, impersonatorSid: 'admin-sid' });

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ impersonatedBy: ADMIN, impersonatorSid: 'admin-sid', isSuperAdmin: false, sid: 's1' }),
    );
    expect(redis.setRefreshToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ impersonatedBy: ADMIN, impersonatorSid: 'admin-sid' }),
    );
    expect(redis.setSession).toHaveBeenCalledWith('u1', expect.objectContaining({ impersonatedBy: ADMIN }), 'rev-1');
  });
});
