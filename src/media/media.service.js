import mongoose from 'mongoose';
import { tenantAudit } from '../restaurantAuth/tenantAudit.js';
import { AppError, Errors } from '../utils/errors.js';
import { detectImageType } from './imageValidation.js';

const DEFAULT_MAX_MB = 5;

const notConfigured = () =>
  new AppError(503, 'Image uploads are not configured on this server', { code: 'IMAGES_NOT_CONFIGURED' });

const TARGETS = {
  product: { model: 'Product', folder: 'products', notFound: 'PRODUCT_NOT_FOUND' },
  category: { model: 'Category', folder: 'categories', notFound: 'CATEGORY_NOT_FOUND' },
};

/**
 * Uploads and removes images for one restaurant. The storage folder is derived
 * from tenant.restaurantId (restaurants/<id>/<kind>), never from the request.
 */
export class MediaService {
  #storage;
  #models;
  #logger;
  #onChange;

  constructor({ storage, registryModels, logger, onChange }) {
    this.#storage = storage;
    this.#models = registryModels;
    this.#logger = logger;
    this.#onChange = onChange;
  }

  get storage() {
    return this.#storage;
  }

  /** Validates the uploaded file against the restaurant's own limit. Returns { ext }. */
  async validate(tenant, file) {
    if (!this.#storage.configured) throw notConfigured();
    if (!file?.buffer?.length) throw Errors.badRequest('Choose an image file', { code: 'NO_FILE' });
    const r = await this.#models.Restaurant.findOne({ restaurantId: tenant.restaurantId }, { limits: 1 }).lean();
    const maxMB = r?.limits?.maxImageSizeMB ?? DEFAULT_MAX_MB;
    if (file.buffer.length > maxMB * 1024 * 1024) {
      throw new AppError(413, `Image is larger than ${maxMB} MB`, { code: 'FILE_TOO_LARGE', details: { maxMB } });
    }
    const type = detectImageType(file.buffer);
    if (!type) throw Errors.badRequest('Only JPG, PNG or WebP images are allowed', { code: 'INVALID_IMAGE' });
    return type;
  }

  async #store(tenant, file, kind) {
    const { ext } = await this.validate(tenant, file);
    return this.#storage.upload(file.buffer, { folder: `restaurants/${tenant.restaurantId}/${kind}`, ext });
  }

  async #discard(publicId) {
    if (!publicId || !this.#storage.configured) return;
    try {
      await this.#storage.destroy(publicId);
    } catch (err) {
      this.#logger?.warn({ err, publicId }, 'Could not delete old image');
    }
  }

  /** product / category image */
  async setItemImage(tenant, target, id, file, ctx) {
    const t = TARGETS[target];
    const Model = tenant.models[t.model];
    if (!mongoose.isValidObjectId(id)) throw Errors.notFound('Not found', { code: t.notFound });
    const item = await Model.findById(id, { image: 1, name: 1 }).lean();
    if (!item) throw Errors.notFound('Not found', { code: t.notFound });

    const stored = await this.#store(tenant, file, t.folder);
    const res = await Model.updateOne({ _id: item._id }, { $set: { image: { url: stored.url, publicId: stored.publicId } } });
    if (res.matchedCount !== 1) {
      await this.#discard(stored.publicId); // deleted meanwhile: don't leave an orphan
      throw Errors.notFound('Not found', { code: t.notFound });
    }
    await this.#discard(item.image?.publicId);
    await this.#audit(tenant, ctx, `${target}.image_set`, target, item._id);
    this.#onChange?.(tenant.restaurantId);
    return stored.publicId;
  }

  async removeItemImage(tenant, target, id, ctx) {
    const t = TARGETS[target];
    const Model = tenant.models[t.model];
    if (!mongoose.isValidObjectId(id)) throw Errors.notFound('Not found', { code: t.notFound });
    const item = await Model.findById(id, { image: 1 }).lean();
    if (!item) throw Errors.notFound('Not found', { code: t.notFound });
    await Model.updateOne({ _id: item._id }, { $unset: { image: 1 } });
    await this.#discard(item.image?.publicId);
    await this.#audit(tenant, ctx, `${target}.image_removed`, target, item._id);
    this.#onChange?.(tenant.restaurantId);
  }

  /** settings logo / banner */
  async setBrandImage(tenant, kind, file, ctx) {
    const { Settings } = tenant.models;
    const current = await Settings.findById('main', { [kind]: 1 }).lean();
    const stored = await this.#store(tenant, file, kind);
    await Settings.updateOne({ _id: 'main' }, { $set: { [kind]: { url: stored.url, publicId: stored.publicId } } }, { upsert: true });
    await this.#discard(current?.[kind]?.publicId);
    await this.#audit(tenant, ctx, `settings.${kind}_set`, 'settings', 'main');
    this.#onChange?.(tenant.restaurantId);
  }

  async removeBrandImage(tenant, kind, ctx) {
    const { Settings } = tenant.models;
    const current = await Settings.findById('main', { [kind]: 1 }).lean();
    await Settings.updateOne({ _id: 'main' }, { $unset: { [kind]: 1 } });
    await this.#discard(current?.[kind]?.publicId);
    await this.#audit(tenant, ctx, `settings.${kind}_removed`, 'settings', 'main');
    this.#onChange?.(tenant.restaurantId);
  }

  /** Called when a product/category is deleted. */
  async discard(publicId) {
    await this.#discard(publicId);
  }

  async #audit(tenant, { actor, ip } = {}, action, resource, resourceId) {
    await tenantAudit(tenant, { userId: actor?.id, action, resource, resourceId: String(resourceId), ip }, this.#logger);
  }
}
