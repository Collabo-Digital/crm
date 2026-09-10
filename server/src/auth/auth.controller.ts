import { Controller, Post, Get, Body, Param, Req, Headers } from '@nestjs/common';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { NoOrgRequired } from './decorators/no-org-required.decorator';
import { AllowVendor } from './decorators/allow-vendor.decorator';
import { AllowInfluencer } from './decorators/allow-influencer.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import { SignupDto } from './dto/signup.dto';
import { SwitchOrgDto } from './dto/switch-org.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

@Controller('auth')
@NoOrgRequired()
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Public()
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.userId, dto.code);
  }

  @Public()
  @Post('resend-verification')
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.userId);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, req.headers['user-agent'], req.ip);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, req.headers['user-agent'], req.ip);
  }

  @Post('logout')
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  // Switch to a different organization — requires valid JWT.
  // @AllowVendor: a vendor-context session (role=VENDOR while inside the
  // invited org) must be able to switch back to its own org. switchOrg still
  // validates active membership in the target org, so this stays safe.
  @Post('switch-org')
  @AllowVendor()
  @AllowInfluencer()
  switchOrg(@CurrentUser() user: JwtPayload, @Body() dto: SwitchOrgDto) {
    return this.authService.switchOrg(user.sub, dto.orgId);
  }

  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Get('invite/:token')
  getInvite(@Param('token') token: string) {
    return this.authService.getInviteByToken(token);
  }

  // Public because someone with no account yet must be able to accept. The
  // Authorization header is read by hand rather than by a guard for the same
  // reason: when a caller IS signed in, acceptance must verify they are the
  // person the invitation names.
  @Public()
  @Post('invite/accept')
  acceptInvite(
    @Body() dto: AcceptInviteDto,
    @Headers('authorization') authorization?: string,
  ) {
    const callerUserId = this.authService.verifyAccessTokenSubject(authorization);
    return this.authService.acceptInvite(dto, callerUserId);
  }
}