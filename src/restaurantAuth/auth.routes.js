import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Errors } from '../utils/errors.js';

export const REFRESH_COOKIE = 'fm_rt';
const COOKIE_PATH = '/api/auth';

const loginSchema = z.object({ email: z.string().max(254), password: z.string().max(256) }).strict();
const setupSchema = z.object({ token: z.string().max(200), password: z.string().max(256) }).strict();
const changeSchema = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).strict();

/**
 * Restaurant user auth: /api/auth/*
 *
 * Refresh cookie: httpOnly, SameSite=Strict, Path=/api/auth, Secure in production.
 * Every POST also requires "X-Requested-With: fetch": plain HTML forms and
 * cross-site requests can't set it without a CORS preflight, which we refuse.
 */
export function restaurantAuthRouter({ authService, requireAuth, cookieSecure, authRateLimit = 20 }) {
  const router = Router();

  const cookieOptions = { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: COOKIE_PATH };

  const respond = (res, result) => {
    const { cookie, ...data } = result;
    if (cookie) res.cookie(REFRESH_COOKIE, cookie.value, { ...cookieOptions, expires: cookie.expiresAt });
    res.json({ success: true, data });
  };

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') {
      return next(Errors.forbidden('Missing X-Requested-With header', { code: 'CSRF_CHECK_FAILED' }));
    }
    next();
  });

  const limiter = (limit) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, message: 'Too many attempts. Try again later', code: 'RATE_LIMITED' },
    });
  const authLimiter = limiter(authRateLimit);
  const refreshLimiter = limiter(authRateLimit * 10);

  const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

  router.post('/login', authLimiter, asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    respond(res, await authService.login({ ...body, ...meta(req) }));
  }));

  router.post('/setup-password', authLimiter, asyncHandler(async (req, res) => {
    const body = setupSchema.parse(req.body);
    respond(res, await authService.setupPassword({ ...body, ...meta(req) }));
  }));

  router.post('/refresh', refreshLimiter, asyncHandler(async (req, res) => {
    const cookieValue = req.cookies?.[REFRESH_COOKIE];
    if (!cookieValue) throw Errors.unauthorized('Session expired. Please sign in again', { code: 'SESSION_EXPIRED' });
    try {
      respond(res, await authService.refresh({ cookieValue }));
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) res.clearCookie(REFRESH_COOKIE, cookieOptions);
      throw err;
    }
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    await authService.logout({ cookieValue: req.cookies?.[REFRESH_COOKIE] });
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.json({ success: true });
  }));

  router.get('/me', requireAuth, (req, res) => {
    res.json({ success: true, data: authService.me(req.tenant, req.user) });
  });

  router.post('/change-password', authLimiter, requireAuth, asyncHandler(async (req, res) => {
    const body = changeSchema.parse(req.body);
    respond(res, await authService.changePassword({ tenant: req.tenant, userId: req.user.id, ...body, ...meta(req) }));
  }));

  return router;
}
