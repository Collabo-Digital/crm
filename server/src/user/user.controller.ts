import { Controller, Get, Patch, Post, Delete, Body } from '@nestjs/common';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoOrgRequired } from '../auth/decorators/no-org-required.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { AuthService } from '../auth/auth.service';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

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
      })),
    };
  }

  @Patch('me')
  @AllowInfluencer()
  async updateProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateUserDto) {
    const updated = await this.userService.update(user.sub, dto);
    return { id: updated.id, email: updated.email, firstName: updated.firstName, lastName: updated.lastName, avatarUrl: updated.avatarUrl };
  }

  @Post('me/change-password')
  @AllowInfluencer()
  async changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto) {
    await this.userService.changePassword(user.sub, dto.currentPassword, dto.newPassword);
    await this.authService.revokeAllUserTokens(user.sub);
    return { message: 'Password changed. All other sessions have been revoked.' };
  }

  @Delete('me')
  async deleteAccount(@CurrentUser() user: JwtPayload) {
    await this.userService.softDelete(user.sub);
    await this.authService.revokeAllUserTokens(user.sub);
    return { message: 'Account deleted.' };
  }
}