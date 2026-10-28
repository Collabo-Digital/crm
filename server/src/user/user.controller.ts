import { Controller, Get, Patch, Post, Delete, Body, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoOrgRequired } from '../auth/decorators/no-org-required.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { AuthService } from '../auth/auth.service';
import { extractGrants } from '../auth/permissions';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Controller('users')
@NoOrgRequired()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
  ) { }

  @Get('me')
  @AllowVendor()
  @AllowInfluencer()
  async getProfile(@CurrentUser() user: JwtPayload) {
    const fullUser = await this.userService.findByIdWithMemberships(user.sub);
    if (!fullUser) return null;
    return {
      id: fullUser.id, email: fullUser.email,
      firstName: fullUser.firstName, lastName: fullUser.lastName,
      avatarUrl: fullUser.avatarUrl, emailVerified: fullUser.emailVerified,
      twoFactorEnabled: fullUser.twoFactorEnabled,
      lastLoginAt: fullUser.lastLoginAt, createdAt: fullUser.createdAt,
      organizations: fullUser.memberships.map((m) => ({
        id: m.organization.id, name: m.organization.name,
        slug: m.organization.slug, type: m.organization.type,
        role: m.role, joinedAt: m.joinedAt,
        vendorScope: m.vendorScope ?? undefined,
        permissions: extractGrants(m.permissions),
      })),
    };
  }

  @Patch('me')
  @AllowVendor()
  @AllowInfluencer()
  async updateProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateUserDto) {
    const updated = await this.userService.update(user.sub, dto);
    return { id: updated.id, email: updated.email, firstName: updated.firstName, lastName: updated.lastName, avatarUrl: updated.avatarUrl };
  }

  @Post('me/change-password')
  @AllowVendor()
  @AllowInfluencer()
  async changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto) {
    await this.userService.changePassword(user.sub, dto.currentPassword, dto.newPassword);
    // The session that made the change stays signed in; every other one ends.
    await this.authService.revokeAllUserTokens(user.sub, user.sid);
    return { message: 'Password changed. All other sessions have been revoked.' };
  }

  // Settings › Security, for a lost or shared phone: every other session of
  // this account ends at once; the one asking stays signed in.
  @Post('me/sign-out-other-devices')
  @HttpCode(200)
  @AllowVendor()
  @AllowInfluencer()
  async signOutOtherDevices(@CurrentUser() user: JwtPayload) {
    await this.authService.revokeAllUserTokens(user.sub, user.sid);
    return { message: 'Signed out of every other device.' };
  }

  // Closing the account cannot be undone, so a signed-in session is not
  // enough: the body carries the password, and a few tries a minute keep it
  // from being guessed here.
  @Delete('me')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async deleteAccount(@CurrentUser() user: JwtPayload, @Body() dto: DeleteAccountDto) {
    await this.userService.softDelete(user.sub, dto.password);
    await this.authService.revokeAllUserTokens(user.sub);
    return { message: 'Account deleted.' };
  }
}