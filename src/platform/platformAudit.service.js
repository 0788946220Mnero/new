/** Platform-level audit trail (separate from each restaurant's auditLogs). Never throws. */
export class PlatformAuditService {
  #model;
  #logger;

  constructor({ model, logger }) {
    this.#model = model;
    this.#logger = logger;
  }

  async log({ actor, action, resource, resourceId, restaurantId, ip, metadata }) {
    try {
      await this.#model.create({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action,
        resource,
        resourceId,
        restaurantId,
        ip,
        metadata,
      });
    } catch (err) {
      this.#logger?.error({ err, action }, 'Failed to write platform audit log');
    }
  }

  async list({ restaurantId, action, page = 1, limit = 50 }) {
    const filter = {};
    if (restaurantId) filter.restaurantId = restaurantId;
    if (action) filter.action = action;
    const [items, total] = await Promise.all([
      this.#model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.#model.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }
}
