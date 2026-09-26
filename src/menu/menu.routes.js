import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/restaurantAuth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const optionalText = (max) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

const localized = (max) =>
  z.object({ ar: z.string().trim().min(1, 'Arabic name is required').max(max), en: optionalText(max) }).strict();

const localizedOptional = (max) =>
  z.object({ ar: optionalText(max), en: optionalText(max) }).strict();

const price = z
  .number()
  .min(0)
  .max(100_000)
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'At most 3 decimal places');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const variant = z.object({ name: localized(40), price }).strict();

const categoryCreate = z.object({ name: localized(80), isVisible: z.boolean().optional() }).strict();
const categoryUpdate = z.object({ name: localized(80), isVisible: z.boolean() }).partial().strict();

const productCreate = z
  .object({
    categoryId: objectId,
    name: localized(120),
    description: localizedOptional(600).optional(),
    price: price.optional(),
    variants: z.array(variant).max(10).optional(),
    badges: z.array(z.enum(['new', 'popular', 'spicy'])).max(3).transform((a) => [...new Set(a)]).optional(),
    isAvailable: z.boolean().optional(),
  })
  .strict();

const productUpdate = z
  .object({
    categoryId: objectId,
    name: localized(120),
    description: localizedOptional(600).nullable(),
    price: price.nullable(),
    variants: z.array(variant).max(10),
    badges: z.array(z.enum(['new', 'popular', 'spicy'])).max(3).transform((a) => [...new Set(a)]),
    isAvailable: z.boolean(),
  })
  .partial()
  .strict();

const order = z.object({ ids: z.array(objectId).max(5000) }).strict();
const productOrder = z.object({ categoryId: objectId, ids: z.array(objectId).max(5000) }).strict();
const availability = z.object({ isAvailable: z.boolean() }).strict();
const deleteCategoryQuery = z.object({ moveTo: objectId.optional() }).strict();
const listProductsQuery = z.object({ categoryId: objectId.optional() }).strict();

const ctx = (req) => ({ actor: req.user, ip: req.ip });

/** /api/categories and /api/products — always scoped to the signed-in user's restaurant. */
export function menuRouters({ menuService, requireAuth }) {
  const categories = Router();
  categories.use(requireAuth);

  categories.get('/', requirePermission('menu.view'), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await menuService.listCategories(req.tenant) });
  }));
  categories.post('/', requirePermission('categories.create'), asyncHandler(async (req, res) => {
    const input = categoryCreate.parse(req.body);
    res.status(201).json({ success: true, data: await menuService.createCategory(req.tenant, input, ctx(req)) });
  }));
  categories.put('/order', requirePermission('categories.reorder'), asyncHandler(async (req, res) => {
    const { ids } = order.parse(req.body);
    res.json({ success: true, data: await menuService.reorderCategories(req.tenant, ids, ctx(req)) });
  }));
  categories.patch('/:id', requirePermission('categories.update'), asyncHandler(async (req, res) => {
    const patch = categoryUpdate.parse(req.body);
    res.json({ success: true, data: await menuService.updateCategory(req.tenant, req.params.id, patch, ctx(req)) });
  }));
  categories.delete('/:id', requirePermission('categories.delete'), asyncHandler(async (req, res) => {
    const { moveTo } = deleteCategoryQuery.parse(req.query);
    res.json({ success: true, data: await menuService.deleteCategory(req.tenant, req.params.id, { moveTo }, ctx(req)) });
  }));

  const products = Router();
  products.use(requireAuth);

  products.get('/', requirePermission('menu.view'), asyncHandler(async (req, res) => {
    const query = listProductsQuery.parse(req.query);
    res.json({ success: true, data: await menuService.listProducts(req.tenant, query) });
  }));
  products.post('/', requirePermission('products.create'), asyncHandler(async (req, res) => {
    const input = productCreate.parse(req.body);
    res.status(201).json({ success: true, data: await menuService.createProduct(req.tenant, input, ctx(req)) });
  }));
  products.put('/order', requirePermission('products.reorder'), asyncHandler(async (req, res) => {
    const { categoryId, ids } = productOrder.parse(req.body);
    res.json({ success: true, data: await menuService.reorderProducts(req.tenant, categoryId, ids, ctx(req)) });
  }));
  products.get('/:id', requirePermission('menu.view'), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await menuService.getProduct(req.tenant, req.params.id) });
  }));
  products.patch('/:id', requirePermission('products.update'), asyncHandler(async (req, res) => {
    const patch = productUpdate.parse(req.body);
    res.json({ success: true, data: await menuService.updateProduct(req.tenant, req.params.id, patch, ctx(req)) });
  }));
  // Separate, narrower permission: a cashier can mark items sold out without editing prices.
  products.post('/:id/availability', requirePermission('products.toggleAvailability'), asyncHandler(async (req, res) => {
    const { isAvailable } = availability.parse(req.body);
    res.json({ success: true, data: await menuService.setAvailability(req.tenant, req.params.id, isAvailable, ctx(req)) });
  }));
  products.delete('/:id', requirePermission('products.delete'), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await menuService.deleteProduct(req.tenant, req.params.id, ctx(req)) });
  }));

  return { categories, products };
}
