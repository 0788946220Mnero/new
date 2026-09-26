import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requirePermission } from '../middleware/restaurantAuth.js';
import { FONTS } from '../settings/settings.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/errors.js';

// Hard ceiling for any upload; each restaurant's own (lower) limit is enforced in MediaService.
const HARD_LIMIT_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_LIMIT_BYTES, files: 1, fields: 0, parts: 2 },
});

/** Runs multer and turns its errors into clean API errors. */
const singleFile = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'Image is too large', { code: 'FILE_TOO_LARGE' }));
    return next(new AppError(400, 'Send one image in the "file" field', { code: 'NO_FILE' }));
  });

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #1F2937');
const httpsUrl = z
  .string()
  .trim()
  .max(200)
  .refine((v) => {
    if (v === '') return true;
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use a full https:// link');
const phone = z.string().trim().max(30).regex(/^(\+?[0-9\s-]{6,20})?$/, 'Invalid phone number');

const settingsPatch = z
  .object({
    info: z
      .object({
        name: z.string().trim().max(120),
        phone,
        whatsapp: phone,
        address: z.string().trim().max(300),
        social: z.object({ instagram: httpsUrl, facebook: httpsUrl, tiktok: httpsUrl }).partial().strict(),
      })
      .partial()
      .strict(),
    theme: z
      .object({ primaryColor: hex, secondaryColor: hex, font: z.enum(FONTS), layout: z.enum(['grid', 'list']) })
      .partial()
      .strict(),
    language: z.enum(['ar', 'en', 'both']),
    hideUnavailableProducts: z.boolean(),
  })
  .partial()
  .strict();

const ctx = (req) => ({ actor: req.user, ip: req.ip });

/** Image upload routes for products/categories + /api/settings. */
export function mediaRouters({ media, settingsService, menuService, requireAuth }) {
  const products = Router();
  products.use(requireAuth);
  products.put('/:id/image', requirePermission('images.upload', 'products.update'), singleFile, asyncHandler(async (req, res) => {
    await media.setItemImage(req.tenant, 'product', req.params.id, req.file, ctx(req));
    res.json({ success: true, data: await menuService.getProduct(req.tenant, req.params.id) });
  }));
  products.delete('/:id/image', requirePermission('images.upload', 'products.update'), asyncHandler(async (req, res) => {
    await media.removeItemImage(req.tenant, 'product', req.params.id, ctx(req));
    res.json({ success: true, data: await menuService.getProduct(req.tenant, req.params.id) });
  }));

  const categories = Router();
  categories.use(requireAuth);
  categories.put('/:id/image', requirePermission('images.upload', 'categories.update'), singleFile, asyncHandler(async (req, res) => {
    await media.setItemImage(req.tenant, 'category', req.params.id, req.file, ctx(req));
    res.json({ success: true });
  }));
  categories.delete('/:id/image', requirePermission('images.upload', 'categories.update'), asyncHandler(async (req, res) => {
    await media.removeItemImage(req.tenant, 'category', req.params.id, ctx(req));
    res.json({ success: true });
  }));

  const settings = Router();
  settings.use(requireAuth);
  settings.get('/', requirePermission('settings.view'), asyncHandler(async (req, res) => {
    res.json({ success: true, data: { ...(await settingsService.get(req.tenant)), imagesEnabled: media.storage.configured } });
  }));
  settings.patch('/', requirePermission('settings.update'), asyncHandler(async (req, res) => {
    const patch = settingsPatch.parse(req.body);
    res.json({ success: true, data: await settingsService.update(req.tenant, patch, ctx(req)) });
  }));
  settings.put('/:kind(logo|banner)', requirePermission('images.upload', 'settings.update'), singleFile, asyncHandler(async (req, res) => {
    await media.setBrandImage(req.tenant, req.params.kind, req.file, ctx(req));
    res.json({ success: true, data: await settingsService.get(req.tenant) });
  }));
  settings.delete('/:kind(logo|banner)', requirePermission('images.upload', 'settings.update'), asyncHandler(async (req, res) => {
    await media.removeBrandImage(req.tenant, req.params.kind, ctx(req));
    res.json({ success: true, data: await settingsService.get(req.tenant) });
  }));

  return { products, categories, settings };
}
