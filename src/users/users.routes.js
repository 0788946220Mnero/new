import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/restaurantAuth.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Employees can be given any permission except managing users (no privilege escalation).
const ASSIGNABLE = PERMISSIONS.filter((p) => p !== 'users.manage');
const permissions = z.array(z.enum(ASSIGNABLE)).max(ASSIGNABLE.length).transform((a) => [...new Set(a)]);
const phone = z.string().trim().regex(/^\+?[0-9\s-]{6,20}$/, 'Invalid phone number');

const inviteSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: phone.optional(),
    permissions: permissions.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    phone,
    permissions,
    status: z.enum(['active', 'disabled']),
  })
  .partial()
  .strict();

/** /api/users — Owner-only employee management. */
export function usersRouter({ usersService, requireAuth }) {
  const router = Router();
  router.use(requireAuth, requirePermission('users.manage'));

  const ctx = (req) => ({ actor: req.user, ip: req.ip });

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await usersService.list(req.tenant) });
  }));

  router.get('/permissions', (_req, res) => {
    res.json({ success: true, data: { assignable: ASSIGNABLE } });
  });

  router.post('/', asyncHandler(async (req, res) => {
    const input = inviteSchema.parse(req.body);
    res.status(201).json({ success: true, data: await usersService.invite(req.tenant, input, ctx(req)) });
  }));

  router.patch('/:userId', asyncHandler(async (req, res) => {
    const patch = updateSchema.parse(req.body);
    res.json({ success: true, data: await usersService.update(req.tenant, req.params.userId, patch, ctx(req)) });
  }));

  router.post('/:userId/reset-access', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await usersService.resetAccess(req.tenant, req.params.userId, ctx(req)) });
  }));

  router.delete('/:userId', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await usersService.remove(req.tenant, req.params.userId, ctx(req)) });
  }));

  return router;
}
