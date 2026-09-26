import mongoose from 'mongoose';
import { imageView } from '../media/imageStorage.js';
import { tenantAudit } from '../restaurantAuth/tenantAudit.js';
import { AppError, Errors } from '../utils/errors.js';

const categoryNotFound = () => Errors.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });
const productNotFound = () => Errors.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });

const DEFAULT_LIMITS = { maxProducts: 300, maxCategories: 40 };

function categoryView(c, productCount = 0, storage) {
  return {
    id: String(c._id),
    name: { ar: c.name?.ar, en: c.name?.en },
    isVisible: c.isVisible !== false,
    sortOrder: c.sortOrder ?? 0,
    productCount,
    image: imageView(c.image, storage),
    updatedAt: c.updatedAt,
  };
}

function productView(p, storage) {
  return {
    id: String(p._id),
    categoryId: String(p.categoryId),
    name: { ar: p.name?.ar, en: p.name?.en },
    description: { ar: p.description?.ar, en: p.description?.en },
    price: p.price ?? null,
    variants: (p.variants ?? []).map((v) => ({ id: String(v._id), name: { ar: v.name?.ar, en: v.name?.en }, price: v.price })),
    badges: p.badges ?? [],
    isAvailable: p.isAvailable !== false,
    sortOrder: p.sortOrder ?? 0,
    image: imageView(p.image, storage),
    updatedAt: p.updatedAt,
  };
}

/**
 * Categories and products of ONE restaurant. Every query runs on tenant.models,
 * i.e. on that restaurant's own database; ids from the client are only ever
 * looked up there, so another restaurant's ids simply don't exist (404).
 */
export class MenuService {
  #models;
  #logger;
  #media;
  #onChange;

  constructor({ registryModels, logger, media, onChange }) {
    this.#models = registryModels;
    this.#logger = logger;
    this.#media = media;
    this.#onChange = onChange;
  }

  get #storage() {
    return this.#media?.storage;
  }

  // ------------------------------------------------------------ categories

  async listCategories(tenant) {
    const { Category, Product } = tenant.models;
    const [categories, counts] = await Promise.all([
      Category.find({}).sort({ sortOrder: 1, _id: 1 }).lean(),
      Product.aggregate([{ $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
    ]);
    const byCategory = new Map(counts.map((c) => [String(c._id), c.n]));
    return categories.map((c) => categoryView(c, byCategory.get(String(c._id)) ?? 0, this.#storage));
  }

  async createCategory(tenant, input, ctx) {
    const { Category } = tenant.models;
    const { maxCategories } = await this.#limits(tenant);
    if ((await Category.countDocuments()) >= maxCategories) {
      throw Errors.conflict(`You can have up to ${maxCategories} categories`, { code: 'CATEGORY_LIMIT', details: { limit: maxCategories } });
    }
    const last = await Category.findOne({}, { sortOrder: 1 }).sort({ sortOrder: -1 }).lean();
    const category = await Category.create({
      name: input.name,
      isVisible: input.isVisible ?? true,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    });
    await this.#audit(tenant, ctx, 'category.created', 'category', category._id, { name: input.name.ar });
    return categoryView(category.toObject(), 0, this.#storage);
  }

  async updateCategory(tenant, id, patch, ctx) {
    const { Category } = tenant.models;
    const category = await this.#category(tenant, id);
    const $set = {};
    if (patch.name) $set.name = patch.name;
    if (patch.isVisible !== undefined) $set.isVisible = patch.isVisible;
    if (Object.keys($set).length) await Category.updateOne({ _id: category._id }, { $set }, { runValidators: true });
    await this.#audit(tenant, ctx, 'category.updated', 'category', category._id, { fields: Object.keys($set) });
    const fresh = await Category.findById(category._id).lean();
    return categoryView(fresh, await tenant.models.Product.countDocuments({ categoryId: category._id }), this.#storage);
  }

  /** A category with products can only be deleted by moving them somewhere else first. */
  async deleteCategory(tenant, id, { moveTo } = {}, ctx) {
    const { Category, Product } = tenant.models;
    const category = await this.#category(tenant, id);
    const productCount = await Product.countDocuments({ categoryId: category._id });

    if (productCount > 0) {
      if (!moveTo) {
        throw Errors.conflict('This category still has products', { code: 'CATEGORY_NOT_EMPTY', details: { productCount } });
      }
      const target = await this.#category(tenant, moveTo).catch(() => {
        throw Errors.badRequest('Target category not found', { code: 'INVALID_CATEGORY' });
      });
      if (String(target._id) === String(category._id)) {
        throw Errors.badRequest('Choose a different category', { code: 'INVALID_CATEGORY' });
      }
      // Append after the target's products, keeping their relative order.
      const last = await Product.findOne({ categoryId: target._id }, { sortOrder: 1 }).sort({ sortOrder: -1 }).lean();
      const offset = (last?.sortOrder ?? -1) + 1;
      const moving = await Product.find({ categoryId: category._id }, { _id: 1 }).sort({ sortOrder: 1, _id: 1 }).lean();
      await Promise.all(
        moving.map((p, i) => Product.updateOne({ _id: p._id }, { $set: { categoryId: target._id, sortOrder: offset + i } })),
      );
    }

    await Category.deleteOne({ _id: category._id });
    await this.#media?.discard(category.image?.publicId);
    await this.#audit(tenant, ctx, 'category.deleted', 'category', category._id, { name: category.name?.ar, movedProducts: productCount, moveTo });
    return { id: String(category._id), deleted: true, movedProducts: productCount };
  }

  async reorderCategories(tenant, ids, ctx) {
    const { Category } = tenant.models;
    const existing = await Category.find({}, { _id: 1 }).lean();
    this.#assertSameSet(existing.map((c) => String(c._id)), ids);
    await Promise.all(ids.map((cid, i) => Category.updateOne({ _id: cid }, { $set: { sortOrder: i } })));
    await this.#audit(tenant, ctx, 'category.reordered', 'category', null, {});
    return this.listCategories(tenant);
  }

  // -------------------------------------------------------------- products

  async listProducts(tenant, { categoryId } = {}) {
    const filter = {};
    if (categoryId) filter.categoryId = (await this.#category(tenant, categoryId))._id;
    const products = await tenant.models.Product.find(filter).sort({ sortOrder: 1, _id: 1 }).lean();
    return products.map((p) => productView(p, this.#storage));
  }

  async getProduct(tenant, id) {
    return productView(await this.#product(tenant, id), this.#storage);
  }

  async createProduct(tenant, input, ctx) {
    const { Product } = tenant.models;
    const { maxProducts } = await this.#limits(tenant);
    if ((await Product.countDocuments()) >= maxProducts) {
      throw Errors.conflict(`You can have up to ${maxProducts} products`, { code: 'PRODUCT_LIMIT', details: { limit: maxProducts } });
    }
    const category = await this.#category(tenant, input.categoryId).catch(() => {
      throw Errors.badRequest('Category not found', { code: 'INVALID_CATEGORY' });
    });
    this.#assertPriced(input.price, input.variants);

    const last = await Product.findOne({ categoryId: category._id }, { sortOrder: 1 }).sort({ sortOrder: -1 }).lean();
    const product = await Product.create({
      categoryId: category._id,
      name: input.name,
      description: input.description,
      price: input.price ?? undefined,
      variants: input.variants ?? [],
      badges: input.badges ?? [],
      isAvailable: input.isAvailable ?? true,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    });
    await this.#audit(tenant, ctx, 'product.created', 'product', product._id, { name: input.name.ar, price: input.price });
    return productView(product.toObject(), this.#storage);
  }

  async updateProduct(tenant, id, patch, ctx) {
    const { Product } = tenant.models;
    const product = await this.#product(tenant, id);
    const $set = {};
    const $unset = {};

    if (patch.name) $set.name = patch.name;
    if (patch.description !== undefined) {
      if (patch.description === null) $unset.description = 1;
      else $set.description = patch.description;
    }
    if (patch.badges) $set.badges = patch.badges;
    if (patch.isAvailable !== undefined) $set.isAvailable = patch.isAvailable;
    if (patch.variants) $set.variants = patch.variants;
    if (patch.price !== undefined) {
      if (patch.price === null) $unset.price = 1;
      else $set.price = patch.price;
    }

    const finalPrice = patch.price !== undefined ? patch.price : product.price;
    const finalVariants = patch.variants ?? product.variants ?? [];
    this.#assertPriced(finalPrice, finalVariants);

    if (patch.categoryId && patch.categoryId !== String(product.categoryId)) {
      const target = await this.#category(tenant, patch.categoryId).catch(() => {
        throw Errors.badRequest('Category not found', { code: 'INVALID_CATEGORY' });
      });
      const last = await Product.findOne({ categoryId: target._id }, { sortOrder: 1 }).sort({ sortOrder: -1 }).lean();
      $set.categoryId = target._id;
      $set.sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) await Product.updateOne({ _id: product._id }, update, { runValidators: true });

    const priceChanged = patch.price !== undefined && (patch.price ?? null) !== (product.price ?? null);
    await this.#audit(tenant, ctx, 'product.updated', 'product', product._id, { fields: [...Object.keys($set), ...Object.keys($unset)] });
    if (priceChanged) {
      await this.#audit(tenant, ctx, 'product.price_changed', 'product', product._id, {
        name: product.name?.ar,
        oldPrice: product.price ?? null,
        newPrice: patch.price ?? null,
      });
    }
    return productView(await Product.findById(product._id).lean(), this.#storage);
  }

  async setAvailability(tenant, id, isAvailable, ctx) {
    const product = await this.#product(tenant, id);
    await tenant.models.Product.updateOne({ _id: product._id }, { $set: { isAvailable } });
    await this.#audit(tenant, ctx, isAvailable ? 'product.made_available' : 'product.made_unavailable', 'product', product._id, { name: product.name?.ar });
    return productView({ ...product, isAvailable }, this.#storage);
  }

  async deleteProduct(tenant, id, ctx) {
    const product = await this.#product(tenant, id);
    await tenant.models.Product.deleteOne({ _id: product._id });
    await this.#audit(tenant, ctx, 'product.deleted', 'product', product._id, { name: product.name?.ar, price: product.price });
    await this.#media?.discard(product.image?.publicId);
    return { id: String(product._id), deleted: true };
  }

  async reorderProducts(tenant, categoryId, ids, ctx) {
    const category = await this.#category(tenant, categoryId);
    const { Product } = tenant.models;
    const existing = await Product.find({ categoryId: category._id }, { _id: 1 }).lean();
    this.#assertSameSet(existing.map((p) => String(p._id)), ids);
    await Promise.all(ids.map((pid, i) => Product.updateOne({ _id: pid, categoryId: category._id }, { $set: { sortOrder: i } })));
    await this.#audit(tenant, ctx, 'product.reordered', 'category', category._id, {});
    return this.listProducts(tenant, { categoryId });
  }

  // --------------------------------------------------------------- helpers

  async #limits(tenant) {
    const r = await this.#models.Restaurant.findOne({ restaurantId: tenant.restaurantId }, { limits: 1 }).lean();
    return { ...DEFAULT_LIMITS, ...(r?.limits ?? {}) };
  }

  async #category(tenant, id) {
    if (!mongoose.isValidObjectId(id)) throw categoryNotFound();
    const c = await tenant.models.Category.findById(id).lean();
    if (!c) throw categoryNotFound();
    return c;
  }

  async #product(tenant, id) {
    if (!mongoose.isValidObjectId(id)) throw productNotFound();
    const p = await tenant.models.Product.findById(id).lean();
    if (!p) throw productNotFound();
    return p;
  }

  #assertPriced(price, variants) {
    if ((price === undefined || price === null) && !(variants?.length > 0)) {
      throw new AppError(400, 'Add a price or at least one size', { code: 'PRICE_REQUIRED' });
    }
  }

  /** Reorder payloads must list every item exactly once — no more, no less. */
  #assertSameSet(existing, ids) {
    const unique = new Set(ids);
    const ok = unique.size === ids.length && ids.length === existing.length && existing.every((id) => unique.has(id));
    if (!ok) throw Errors.badRequest('The order must include every item exactly once', { code: 'INVALID_ORDER' });
  }

  async #audit(tenant, { actor, ip }, action, resource, resourceId, metadata) {
    this.#onChange?.(tenant.restaurantId); // every audited menu write changes the public menu
    await tenantAudit(tenant, { userId: actor?.id, action, resource, resourceId: resourceId ? String(resourceId) : undefined, ip, metadata }, this.#logger);
  }
}
