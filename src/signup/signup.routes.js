import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { passwordSchema } from '../auth/password.js';
import { REFRESH_COOKIE } from '../restaurantAuth/auth.routes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Errors } from '../utils/errors.js';

const signupSchema = z
  .object({
    restaurantName: z.string().trim().min(2).max(120),
    slug: z.string().trim().max(50).optional().transform((v) => (v ? v.toLowerCase() : undefined)),
    ownerName: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().regex(/^\+?[0-9\s-]{6,20}$/, 'Invalid phone number'),
    password: passwordSchema,
    website: z.string().max(200).optional(), // honeypot: people never see or fill it
  })
  .strict();

/** POST /api/signup — public, strictly rate limited. */
export function signupRouter({ signupService, cookieSecure, signupRateLimit = 5 }) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: signupRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many sign-ups from this network. Try again later', code: 'RATE_LIMITED' },
  });

  router.get('/config', (_req, res) => {
    res.json({ success: true, data: { trialDays: signupService.trialDays } });
  });

  router.post('/', limiter, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('x-requested-with') !== 'fetch') {
      throw Errors.forbidden('Missing X-Requested-With header', { code: 'CSRF_CHECK_FAILED' });
    }
    const input = signupSchema.parse(req.body);
    if (input.website) throw Errors.badRequest('Could not create the account', { code: 'SIGNUP_REJECTED' });

    const { cookie, ...data } = await signupService.signup(input, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(REFRESH_COOKIE, cookie.value, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/api/auth', expires: cookie.expiresAt });
    res.status(201).json({ success: true, data });
  }));
  return router;
}
