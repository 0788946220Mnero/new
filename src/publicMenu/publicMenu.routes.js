import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../utils/asyncHandler.js';

/** GET /api/public/menu/:slug — no authentication, read-only, rate limited, ETag-revalidated. */
export function publicMenuRouter({ publicMenu, rateLimitPerMinute = 240 }) {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests', code: 'RATE_LIMITED' },
    }),
  );
  router.get('/menu/:slug', asyncHandler(async (req, res) => {
    const data = await publicMenu.get(req.params.slug);
    // Always revalidate: an owner who changes a price and reopens the menu must see it at once.
    // Express adds an ETag, so an unchanged menu costs a tiny 304 response, not the full JSON.
    res.set('Cache-Control', 'no-cache');
    res.json({ success: true, data });
  }));
  return router;
}
