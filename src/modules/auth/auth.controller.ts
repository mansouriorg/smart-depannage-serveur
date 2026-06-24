import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthService } from './auth.service';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// DTOs for the new auth features
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ==========================================================
  // 1. REGISTER
  // POST /auth/register
  // ==========================================================

  @Post('register')
  async register(@Body() credentialsDto: AuthCredentialsDto) {
    return this.authService.register(credentialsDto);
  }

  // ==========================================================
  // 2. LOGIN
  // POST /auth/login
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() credentialsDto: AuthCredentialsDto) {
    return this.authService.login(
      credentialsDto.email,
      credentialsDto.password,
    );
  }

  // ==========================================================
  // 3. REFRESH TOKEN
  // POST /auth/refresh
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // ==========================================================
  // 4. LOGOUT
  // POST /auth/logout
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  // ==========================================================
  // 5. LOGOUT EVERYWHERE
  // POST /auth/logout-everywhere
  // Requires accessToken
  // ==========================================================

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout-everywhere')
  async logoutEverywhere(@CurrentUser('id') userId: number) {
    return this.authService.logoutEverywhere(userId);
  }

  // ==========================================================
  // 6. FORGOT PASSWORD
  // POST /auth/forgot-password
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  // ==========================================================
  // 7. RESET PASSWORD
  // POST /auth/reset-password
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  // ==========================================================
  // 8. CHANGE PASSWORD
  // POST /auth/change-password
  // Requires accessToken
  // ==========================================================

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(
    @CurrentUser('id') userId: number,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  // ==========================================================
  // 9. SEND EMAIL VERIFICATION
  // POST /auth/email/send-verification
  // Requires accessToken
  // ==========================================================

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('email/send-verification')
  async sendEmailVerification(@CurrentUser('id') userId: number) {
    return this.authService.sendEmailVerification(userId);
  }

  // ==========================================================
  // 10. VERIFY EMAIL
  // POST /auth/email/verify
  // ==========================================================

  @HttpCode(HttpStatus.OK)
  @Post('email/verify')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  // ==========================================================
  // 11. SEND PHONE VERIFICATION CODE
  // POST /auth/phone/send-code
  // Requires accessToken
  // ==========================================================

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('phone/send-code')
  async sendPhoneVerification(@CurrentUser('id') userId: number) {
    return this.authService.sendPhoneVerification(userId);
  }

  // ==========================================================
  // 12. VERIFY PHONE
  // POST /auth/phone/verify
  // Requires accessToken
  // ==========================================================

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('phone/verify')
  async verifyPhone(
    @CurrentUser('id') userId: number,
    @Body() dto: VerifyPhoneDto,
  ) {
    return this.authService.verifyPhone(userId, dto.code);
  }
}