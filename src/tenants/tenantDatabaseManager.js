import { AppError } from '../utils/errors.js';
import { TtlCache } from '../utils/ttlCache.js';
import { getTenantModels } from './tenant.models.js';
import { databaseNameFor, isValidRestaurantId, normalizeSlug } from './tenantNaming.js';

const notFound = () =>
  new AppError(404, 'Restaurant not found', { code: 'TENANT_NOT_FOUND' });

const unavailable = () =>
  new AppError(403, 'This restaurant is currently unavailable', { code: 'TENANT_UNAVAILABLE' });

const trialExpired = () =>
  new AppError(403, 'The free trial for this restaurant has ended', { code: 'TRIAL_EXPIRED' });

const routingInvalid = () =>
  new AppError(500, 'Internal server error', { code: 'TENANT_ROUTING_INVALID' });

/**
 * Resolves a restaurant (by authenticated restaurantId or public slug) to its
 * dedicated database handle.
 *
 * - Input ids/slugs are validated before touching the registry.
 * - Only "active" restaurants resolve. Suspended/archived -> 403, anything else -> 404.
 * - The database name must equal the one derived from restaurantId, so even a
 *   corrupted registry record can't point a tenant at the registry or at
 *   another restaurant's database.
 * - Routing records are cached (TTL) and concurrent lookups are de-duplicated.
 *   Call invalidate(restaurantId) whenever status or slug changes.
 *   With several server instances, other instances pick the change up within the TTL.
 */
export class TenantDatabaseManager {
  #registry;
  #clusters;
  #registryDbName;
  #logger;
  #notFoundTtlMs;
  #routes; // restaurantId -> routing | null
  #slugs; // slug -> restaurantId | null
  #inflight = new Map();
  #now;

  constructor({
    registry,
    clusters,
    registryDbName,
    cacheTtlMs = 30_000,
    notFoundTtlMs = 10_000,
    maxEntries = 10_000,
    now = () => Date.now(),
    logger,
  }) {
    if (!registry || !clusters || !registryDbName) {
      throw new Error('TenantDatabaseManager requires registry, clusters and registryDbName');
    }
    this.#registry = registry;
    this.#clusters = clusters;
    this.#registryDbName = registryDbName;
    this.#logger = logger;
    this.#notFoundTtlMs = notFoundTtlMs;
    this.#now = now;
    this.#routes = new TtlCache({ ttlMs: cacheTtlMs, maxEntries, now });
    this.#slugs = new TtlCache({ ttlMs: cacheTtlMs, maxEntries, now });
  }

  /** For authenticated requests: restaurantId comes from the verified token only. */
  async resolveById(restaurantId) {
    if (!isValidRestaurantId(restaurantId)) throw notFound();
    const routing = await this.#getRoutingById(restaurantId);
    return this.#buildContext(routing);
  }

  /** For the public menu: slug comes from the URL. */
  async resolveBySlug(rawSlug) {
    const slug = normalizeSlug(rawSlug);
    if (!slug) throw notFound();

    const cachedId = this.#slugs.get(slug);
    if (cachedId === null) throw notFound();

    if (cachedId !== undefined) {
      const routing = await this.#getRoutingById(cachedId);
      if (routing.slug === slug) return this.#buildContext(routing);
      this.#slugs.delete(slug); // slug was renamed; fall through to a fresh lookup
    }

    const routing = await this.#dedupe(`slug:${slug}`, () =>
      this.#registry.findTenantRoutingBySlug(slug),
    );
    if (!routing) {
      this.#slugs.set(slug, null, this.#notFoundTtlMs);
      throw notFound();
    }
    return this.#buildContext(this.#remember(routing));
  }

  /** Drop cached routing for a restaurant (call after status/slug changes or provisioning). */
  invalidate(restaurantId) {
    this.#routes.delete(restaurantId);
    for (const [slug, id] of [...this.#slugs.entries()]) {
      if (id === restaurantId) this.#slugs.delete(slug);
    }
  }

  /** Forget a cached "slug not found" (call after a restaurant is created with that slug). */
  invalidateSlug(slug) {
    const normalized = normalizeSlug(slug);
    if (normalized) this.#slugs.delete(normalized);
  }

  clear() {
    this.#routes.clear();
    this.#slugs.clear();
  }

  async #getRoutingById(restaurantId) {
    const cached = this.#routes.get(restaurantId);
    if (cached === null) throw notFound();
    if (cached) return cached;

    const routing = await this.#dedupe(`id:${restaurantId}`, () =>
      this.#registry.findTenantRoutingById(restaurantId),
    );
    if (!routing) {
      this.#routes.set(restaurantId, null, this.#notFoundTtlMs);
      throw notFound();
    }
    return this.#remember(routing);
  }

  #remember(raw) {
    const routing = Object.freeze({
      restaurantId: raw.restaurantId,
      slug: raw.slug,
      name: raw.name,
      databaseName: raw.databaseName,
      clusterId: raw.clusterId ?? 'primary',
      status: raw.status,
      approved: raw.approved !== false,
      trialEndsAt: raw.trialEndsAt ? new Date(raw.trialEndsAt) : null,
    });
    this.#routes.set(routing.restaurantId, routing);
    if (routing.slug) this.#slugs.set(routing.slug, routing.restaurantId);
    return routing;
  }

  async #buildContext(routing) {
    if (routing.status !== 'active') {
      if (routing.status === 'suspended' || routing.status === 'archived') throw unavailable();
      throw notFound(); // provisioning / failed are invisible
    }
    // Checked on every request (not by a scheduled job), so expiry is exact and can't be missed.
    if (!routing.approved && (!routing.trialEndsAt || routing.trialEndsAt.getTime() <= this.#now())) {
      throw trialExpired();
    }

    let expected;
    try {
      expected = databaseNameFor(routing.restaurantId);
    } catch {
      expected = null;
    }
    if (
      !expected ||
      routing.databaseName !== expected ||
      routing.databaseName === this.#registryDbName
    ) {
      this.#logger?.error(
        { restaurantId: routing.restaurantId },
        'Registry routing integrity violation — refusing to open database',
      );
      throw routingInvalid();
    }

    const connection = await this.#clusters.connect(routing.clusterId);
    const db = connection.useDb(routing.databaseName, { useCache: true });

    return Object.freeze({
      restaurantId: routing.restaurantId,
      slug: routing.slug,
      name: routing.name,
      databaseName: routing.databaseName,
      clusterId: routing.clusterId,
      trialEndsAt: routing.approved ? null : routing.trialEndsAt,
      db,
      models: getTenantModels(db),
    });
  }

  #dedupe(key, fn) {
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }
}
