import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SESSION_COOKIE } from './session.cookie.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const token: string | undefined = request.cookies?.[SESSION_COOKIE] ?? bearer;
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      request.user = await this.jwt.verifyAsync(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
