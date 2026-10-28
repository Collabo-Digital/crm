import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * A token refresh must keep the organization the session was in. It used to
 * re-issue the access token for memberships[0], which moved a multi-org user
 * back to their first org every time the 15-minute access token expired.
 */
describe('AuthService.rotateRefreshToken — organization is preserved', () => {
  const memberships = [
    { organizationId: 'org-a', role: 'OWNER', vendorScope: null },
    { organizationId: 'org-b', role: 'ADMIN', vendorScope: null },
  ];

  function build(stored: { userId: string; orgId?: string; sid?: string } | null) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'u1@example.com',
          deletedAt: null,
          emailVerified: true,
          isSuperAdmin: false,
          memberships,
        }),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue(undefined),
      },
    };
    const redis = {
      consumeRefreshToken: jest.fn().mockResolvedValue(stored),
      getRefreshRotation: jest.fn().mockResolvedValue(null),
      setRefreshRotationResult: jest.fn().mockResolvedValue(undefined),
      clearRefreshRotation: jest.fn().mockResolvedValue(undefined),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      trackUserToken: jest.fn().mockResolvedValue(undefined),
      sessionRevision: jest.fn().mockResolvedValue('rev-1'),
      setSession: jest.fn().mockResolvedValue(true),
      setAuthSession: jest.fn().mockResolvedValue(undefined),
      deleteAuthSession: jest.fn().mockResolvedValue(undefined),
    };
    const jwt = { sign: jest.fn().mockReturnValue('access') };
    const config = { get: jest.fn().mockReturnValue('7d') };

    const service = new AuthService(
      prisma as never,
      jwt as never,
      config as never,
      {} as never,
      {} as never,
      redis as never,
    );
    return { service, redis, jwt };
  }

  it('re-issues the token for the org stored with the refresh token', async () => {
    const { service, redis, jwt } = build({ userId: 'u1', orgId: 'org-b' });

    await service.rotateRefreshToken('old');

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-b', role: 'ADMIN' }),
    );
    // The next refresh token carries the org forward too.
    expect(redis.setRefreshToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: 'u1', orgId: 'org-b' }),
    );
    // The cached session keeps every membership, not just one.
    expect(redis.setSession).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        orgId: 'org-b',
        memberships: expect.arrayContaining([
          expect.objectContaining({ orgId: 'org-a' }),
          expect.objectContaining({ orgId: 'org-b' }),
        ]),
      }),
      'rev-1',
    );
  });

  it('falls back to the first membership for a token stored without an org', async () => {
    const { service, jwt } = build({ userId: 'u1' });

    await service.rotateRefreshToken('old');

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-a' }),
    );
  });

  it('ends the session when the stored org is no longer a membership', async () => {
    const { service, jwt, redis } = build({ userId: 'u1', orgId: 'org-gone', sid: 's1' });

    // Re-issuing for org-a would move the user to another tenant while the UI
    // still names the one they were removed from.
    await expect(service.rotateRefreshToken('old')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
    expect(redis.deleteAuthSession).toHaveBeenCalledWith('s1', 'u1');
  });
});
