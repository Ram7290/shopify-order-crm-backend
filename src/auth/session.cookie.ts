import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'crm_session';
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  };
}
