import { toPublicRecord } from '../provisioning/restaurantProvisioning.service.js';
import { RESTAURANT_STATUSES } from '../registry/registry.models.js';
import { getTenantModels } from '../tenants/tenant.models.js';
import { databaseNameFor, isValidRestaurantId, normalizeSlug } from '../tenants/tenantNaming.js';
import { Errors } from '../utils/errors.js';

const TRANSITIONS = Object.freeze({
  suspend: { from: ['active'], to: 'suspended', event: 'restaurant.suspended' },
  activate: { from: ['suspended', 'archived'], to: 'active', event: 'restaurant.activated' },
  archive: { from: ['active', 'suspended'], to: 'archived', event: 'restaurant.archived' },
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Everyday Super Admin operations on existing restaurants. */
export class RestaurantAdminService {
  #models;
  #clusters;
  #tenantManager;
  #audit;
  #now;
  #sessions;

  constructor({ registryModels, clusters, tenantManager, audit, sessions, now = () => Date.now() }) {
    this.#sessions = sessions;
    this.#models = registryModels;
    this.#clusters = clusters;
    this.#tenantManager = tenantManager;
    this.#audit = audit;
    this.#now = now;
  }

  async list({ q, status, page = 1, limit = 25 }) {
    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(escapeRegex(q.trim()), 'i');
      filter.$or = [{ name: rx }, { slug: rx }, { restaurantId: rx }, { 'owner.email': rx }, { 'owner.name': rx }];
    }
    const { Restaurant } = this.#models;
    const [items, total] = await Promise.all([
      Restaurant.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Restaurant.countDocuments(filter),
    ]);
    return { items: items.map(toPublicRecord), total, page, limit };
  }

  /** Restaurant counts by status, for the dashboard. */
  async stats() {
    const rows = await this.#models.Restaurant.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byStatus = Object.fromEntries(RESTAURANT_STATUSES.map((s) => [s, 0]));
    for (const row of rows) byStatus[row._id] = row.count;
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  }

  async get(restaurantId) {
    const record = await this.#find(restaurantId);
    let stats = null;
    if (record.provisioningSteps?.collections) {
      try {
        const conn = await this.#clusters.connect(record.clusterId ?? 'primary');
        const db = conn.useDb(databaseNameFor(record.restaurantId), { useCache: true });
        const { Product, Category } = getTenantModels(db);
        const [products, categories] = await Promise.all([
          Product.estimatedDocumentCount(),
          Category.estimatedDocumentCount(),
        ]);
        stats = { products, categories };
      } catch {
        stats = null;
      }
    }
    return { ...toPublicRecord(record), stats };
  }

  /** patch is validated (strict schema) by the route. */
  async update(restaurantId, patch, { actor, ip } = {}) {
    const record = await this.#find(restaurantId);
    if (record.status === 'provisioning') {
      throw Errors.conflict('Restaurant is still being provisioned', { code: 'INVALID_STATE' });
    }

    const $set = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.notes !== undefined) $set.notes = patch.notes;
    for (const key of ['phone', 'email', 'address']) {
      if (patch[key] !== undefined) $set[`contact.${key}`] = patch[key];
    }
    for (const [key, value] of Object.entries(patch.limits ?? {})) {
      $set[`limits.${key}`] = value;
    }
    if (patch.slug !== undefined) {
      const slug = normalizeSlug(patch.slug);
      if (!slug) throw Errors.badRequest('Invalid or reserved slug', { code: 'INVALID_SLUG' });
      if (slug !== record.slug) {
        if (await this.#models.Restaurant.exists({ slug, restaurantId: { $ne: restaurantId } })) {
          throw Errors.conflict('This slug is already in use', { code: 'SLUG_TAKEN' });
        }
        $set.slug = slug;
      }
    }
    if (!Object.keys($set).length) return toPublicRecord(record);

    let updated;
    try {
      updated = await this.#models.Restaurant.findOneAndUpdate(
        { restaurantId },
        { $set },
        { new: true, runValidators: true },
      ).lean();
    } catch (err) {
      // slug is the only unique field this update can touch (race with another update).
      if (err?.code === 11000 && $set.slug) {
        throw Errors.conflict('This slug is already in use', { code: 'SLUG_TAKEN' });
      }
      throw err;
    }

    this.#tenantManager.invalidate(restaurantId);
    if ($set.slug) this.#tenantManager.invalidateSlug($set.slug);

    await this.#audit.log({
      actor,
      ip,
      action: 'restaurant.updated',
      resource: 'restaurant',
      resourceId: restaurantId,
      restaurantId,
      metadata: { fields: Object.keys($set), ...($set.slug ? { oldSlug: record.slug, newSlug: $set.slug } : {}) },
    });
    return toPublicRecord(updated);
  }

  async changeStatus(restaurantId, action, { actor, ip } = {}) {
    const rule = TRANSITIONS[action];
    if (!rule) throw Errors.notFound();
    const record = await this.#find(restaurantId);

    const updated = await this.#models.Restaurant.findOneAndUpdate(
      { restaurantId, status: { $in: rule.from } },
      { $set: { status: rule.to, statusChangedAt: new Date(this.#now()) } },
      { new: true },
    ).lean();
    if (!updated) {
      throw Errors.conflict(`Cannot ${action} a restaurant that is ${record.status}`, { code: 'INVALID_STATE' });
    }

    // Takes effect immediately on this instance; other instances within the cache TTL.
    this.#tenantManager.invalidate(restaurantId);
    if (rule.to !== 'active') await this.#sessions?.revokeAllForRestaurant(restaurantId);

    await this.#audit.log({
      actor,
      ip,
      action: rule.event,
      resource: 'restaurant',
      resourceId: restaurantId,
      restaurantId,
      metadata: { from: record.status, to: rule.to },
    });
    return toPublicRecord(updated);
  }

  async #find(restaurantId) {
    if (!isValidRestaurantId(restaurantId)) throw Errors.notFound('Restaurant not found', { code: 'TENANT_NOT_FOUND' });
    const record = await this.#models.Restaurant.findOne({ restaurantId }).lean();
    if (!record) throw Errors.notFound('Restaurant not found', { code: 'TENANT_NOT_FOUND' });
    return record;
  }
}
