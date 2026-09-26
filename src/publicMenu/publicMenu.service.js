import { imageView } from '../media/imageStorage.js';
import { settingsView } from '../settings/settings.service.js';
import { TtlCache } from '../utils/ttlCache.js';

/**
 * The customer-facing menu. Read-only, built from the restaurant's own database,
 * and returns ONLY what customers should see: visible categories, their products
 * (optionally without unavailable ones), prices, images and public contact info.
 * Cached per restaurant; any menu/settings change invalidates it immediately.
 */
export class PublicMenuService {
  #tenantManager;
  #storage;
  #cache;

  constructor({ tenantManager, storage, cacheTtlMs = 60_000, now }) {
    this.#tenantManager = tenantManager;
    this.#storage = storage;
    this.#cache = new TtlCache({ ttlMs: cacheTtlMs, maxEntries: 5_000, now });
  }

  invalidate(restaurantId) {
    this.#cache.delete(restaurantId);
  }

  async get(slug) {
    // Status (suspended/archived/unknown) is checked on every request, never cached here.
    const tenant = await this.#tenantManager.resolveBySlug(slug);
    const cached = this.#cache.get(tenant.restaurantId);
    if (cached) return cached;

    const { Category, Product, Settings } = tenant.models;
    const [settingsDoc, categories, products] = await Promise.all([
      Settings.findById('main').lean(),
      Category.find({ isVisible: { $ne: false } }).sort({ sortOrder: 1, _id: 1 }).lean(),
      Product.find({}).sort({ sortOrder: 1, _id: 1 }).lean(),
    ]);
    const settings = settingsView(settingsDoc, this.#storage);

    const byCategory = new Map();
    for (const p of products) {
      if (settings.hideUnavailableProducts && p.isAvailable === false) continue;
      const key = String(p.categoryId);
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push({
        id: String(p._id),
        name: { ar: p.name?.ar, en: p.name?.en },
        description: { ar: p.description?.ar, en: p.description?.en },
        price: p.price ?? null,
        variants: (p.variants ?? []).map((v) => ({ name: { ar: v.name?.ar, en: v.name?.en }, price: v.price })),
        badges: p.badges ?? [],
        isAvailable: p.isAvailable !== false,
        image: imageView(p.image, this.#storage),
      });
    }

    const menu = {
      restaurant: {
        name: settings.info.name || tenant.name,
        slug: tenant.slug,
        phone: settings.info.phone || null,
        whatsapp: settings.info.whatsapp || null,
        address: settings.info.address || null,
        social: Object.fromEntries(Object.entries(settings.info.social).filter(([, v]) => v)),
        logo: settings.logo,
        banner: settings.banner,
        language: settings.language,
      },
      theme: settings.theme,
      categories: categories
        .map((c) => ({
          id: String(c._id),
          name: { ar: c.name?.ar, en: c.name?.en },
          image: imageView(c.image, this.#storage),
          products: byCategory.get(String(c._id)) ?? [],
        }))
        .filter((c) => c.products.length > 0),
    };
    this.#cache.set(tenant.restaurantId, menu);
    return menu;
  }
}
