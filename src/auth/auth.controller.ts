import { Body, Controller, Get, HttpCode, Post, Res, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './auth.guard.js';
import { LoginDto } from './dto/login.dto.js';
import { SESSION_COOKIE, sessionCookieOptions } from './session.cookie.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ login: { limit: 5, ttl: 15 * 60_000 } })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.login(body.email, body.password);
    res.cookie(SESSION_COOKIE, session.accessToken, sessionCookieOptions());
    return { user: session.user };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request & { user: { sub: string; email: string } }) {
    return { user: { id: req.user.sub, email: req.user.email } };
  }
}
