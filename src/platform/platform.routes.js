import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requirePlatformAuth } from '../middleware/platformAuth.js';
import { RESTAURANT_STATUSES } from '../registry/registry.models.js';
import { RESTAURANT_ID_REGEX } from '../tenants/tenantNaming.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Errors } from '../utils/errors.js';

const str = (max) => z.string().trim().min(1).max(max);
const phone = z.string().trim().regex(/^\+?[0-9\s-]{6,20}$/, 'Invalid phone number');
const email = z.string().trim().toLowerCase().email().max(254);

const limitsSchema = z
  .object({
    maxProducts: z.number().int().min(1).max(5000),
    maxCategories: z.number().int().min(1).max(500),
    maxImageSizeMB: z.number().int().min(1).max(20),
  })
  .partial()
  .strict();

// .strict(): unknown fields (status, databaseName, restaurantId, ...) are rejected, not ignored.
const createRestaurantSchema = z
  .object({
    name: str(120),
    slug: z.string().trim().max(50).optional(),
    phone: phone.optional(),
    email: email.optional(),
    address: str(300).optional(),
    notes: z.string().trim().max(2000).optional(),
    limits: limitsSchema.optional(),
    owner: z
      .object({
        name: str(100),
        email,
        phone: phone.optional(),
      })
      .strict(),
  })
  .strict();

const updateRestaurantSchema = z
  .object({
    name: str(120),
    slug: z.string().trim().max(50),
    phone,
    email,
    address: str(300),
    notes: z.string().trim().max(2000),
    limits: limitsSchema,
  })
  .partial()
  .strict();

const listSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(RESTAURANT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

// "restaurant", not "restaurantId": restaurantId is stripped from every query string by design.
const auditListSchema = z
  .object({
    restaurant: z.string().regex(RESTAURANT_ID_REGEX).optional(),
    action: z.string().regex(/^[a-z_.]{1,80}$/).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const loginSchema = z.object({ email: z.string().max(254), password: z.string().max(256) }).strict();
const mfaSchema = z.object({ challengeToken: z.string().max(2048), code: z.string().max(10) }).strict();
const changePasswordSchema = z
  .object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) })
  .strict();

function restaurantIdParam(req) {
  const { restaurantId } = req.params;
  if (!RESTAURANT_ID_REGEX.test(restaurantId)) throw Errors.notFound('Restaurant not found', { code: 'TENANT_NOT_FOUND' });
  return restaurantId;
}

const ctx = (req) => ({ actor: req.platformUser, ip: req.ip });

export function platformRouter({ authService, provisioning, restaurantAdmin, audit, authRateLimit = 20 }) {
  const router = Router();

  // Super Admin responses must never be cached by browsers or proxies.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---------------------------------------------------------------- auth
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Try again later', code: 'RATE_LIMITED' },
  });

  router.post('/auth/login', authLimiter, asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json({ success: true, data: await authService.login({ ...body, ip: req.ip }) });
  }));

  router.post('/auth/mfa/setup', authLimiter, asyncHandler(async (req, res) => {
    const body = mfaSchema.parse(req.body);
    res.json({ success: true, data: await authService.completeMfaSetup({ ...body, ip: req.ip }) });
  }));

  router.post('/auth/mfa/verify', authLimiter, asyncHandler(async (req, res) => {
    const body = mfaSchema.parse(req.body);
    res.json({ success: true, data: await authService.verifyMfa({ ...body, ip: req.ip }) });
  }));

  const authedAllowPending = requirePlatformAuth(authService, { allowPasswordChangePending: true });

  router.get('/auth/me', authedAllowPending, (req, res) => {
    res.json({ success: true, data: req.platformUser });
  });

  router.post('/auth/change-password', authLimiter, authedAllowPending, asyncHandler(async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    const data = await authService.changePassword({ userId: req.platformUser.id, ...body, ip: req.ip });
    res.json({ success: true, data });
  }));

  router.post('/auth/logout', authedAllowPending, asyncHandler(async (req, res) => {
    await authService.logout({ userId: req.platformUser.id, email: req.platformUser.email, ip: req.ip });
    res.json({ success: true });
  }));

  // ---------------------------------------------------------- restaurants
  router.use(requirePlatformAuth(authService));

  router.get('/stats', asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await restaurantAdmin.stats() });
  }));

  router.get('/restaurants', asyncHandler(async (req, res) => {
    const query = listSchema.parse(req.query);
    res.json({ success: true, data: await restaurantAdmin.list(query) });
  }));

  router.post('/restaurants', asyncHandler(async (req, res) => {
    const input = createRestaurantSchema.parse(req.body);
    const data = await provisioning.create(input, ctx(req));
    res.status(201).json({ success: true, data });
  }));

  router.get('/restaurants/:restaurantId', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await restaurantAdmin.get(restaurantIdParam(req)) });
  }));

  router.patch('/restaurants/:restaurantId', asyncHandler(async (req, res) => {
    const id = restaurantIdParam(req);
    const patch = updateRestaurantSchema.parse(req.body);
    res.json({ success: true, data: await restaurantAdmin.update(id, patch, ctx(req)) });
  }));

  router.post('/restaurants/:restaurantId/:action(suspend|activate|archive)', asyncHandler(async (req, res) => {
    const id = restaurantIdParam(req);
    res.json({ success: true, data: await restaurantAdmin.changeStatus(id, req.params.action, ctx(req)) });
  }));

  router.post('/restaurants/:restaurantId/retry-provisioning', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await provisioning.retry(restaurantIdParam(req), ctx(req)) });
  }));

  router.post('/restaurants/:restaurantId/reset-owner-access', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await provisioning.resetOwnerAccess(restaurantIdParam(req), ctx(req)) });
  }));

  // Only for restaurants whose provisioning failed. Live restaurants are archived, never deleted.
  router.delete('/restaurants/:restaurantId', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await provisioning.cleanup(restaurantIdParam(req), ctx(req)) });
  }));

  // ------------------------------------------------------------ audit logs
  router.get('/audit-logs', asyncHandler(async (req, res) => {
    const { restaurant, ...rest } = auditListSchema.parse(req.query);
    res.json({ success: true, data: await audit.list({ restaurantId: restaurant, ...rest }) });
  }));

  return router;
}
