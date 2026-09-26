import { isValidRestaurantId, normalizeSlug } from '../tenants/tenantNaming.js';

const ROUTING_FIELDS = {
  _id: 0,
  restaurantId: 1,
  slug: 1,
  name: 1,
  databaseName: 1,
  clusterId: 1,
  status: 1,
};

export class RegistryService {
  #models;

  constructor({ models }) {
    this.#models = models;
  }

  get models() {
    return this.#models;
  }

  /** Creates registry collections and indexes (idempotent). Called at boot. */
  async ensureIndexes() {
    for (const model of Object.values(this.#models)) {
      await model.createCollection();
      await model.createIndexes();
    }
  }

  /** Minimal routing record for a restaurant, or null. Input is type-checked (no operator injection). */
  async findTenantRoutingById(restaurantId) {
    if (!isValidRestaurantId(restaurantId)) return null;
    return this.#models.Restaurant.findOne({ restaurantId }, ROUTING_FIELDS).lean();
  }

  async findTenantRoutingBySlug(rawSlug) {
    const slug = normalizeSlug(rawSlug);
    if (!slug) return null;
    return this.#models.Restaurant.findOne({ slug }, ROUTING_FIELDS).lean();
  }
}
