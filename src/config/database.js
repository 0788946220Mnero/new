import mongoose from 'mongoose';

/**
 * Holds ONE Mongoose connection (with its own pool) per Atlas cluster.
 * Tenant databases are opened on top of these with useDb() — never a new
 * connection per request or per restaurant.
 */
export class ClusterConnections {
  #uris;
  #logger;
  #options;
  #connections = new Map(); // clusterId -> Promise<Connection>

  constructor({ uris, logger, options = {} }) {
    this.#uris = uris;
    this.#logger = logger;
    this.#options = options;
  }

  has(clusterId) {
    return Object.hasOwn(this.#uris, clusterId);
  }

  connect(clusterId) {
    const existing = this.#connections.get(clusterId);
    if (existing) return existing;

    if (!this.has(clusterId)) {
      return Promise.reject(new Error(`Unknown clusterId "${clusterId}"`));
    }

    const conn = mongoose.createConnection(this.#uris[clusterId], {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 10_000,
      // Nothing is created implicitly: collections and indexes are only
      // created on purpose (registry at boot, tenants at provisioning).
      autoIndex: false,
      autoCreate: false,
      ...this.#options,
    });

    const log = this.#logger?.child({ clusterId });
    conn.on('disconnected', () => log?.warn('MongoDB disconnected'));
    conn.on('reconnected', () => log?.info('MongoDB reconnected'));
    conn.on('error', (err) => log?.error({ err: { message: err.message } }, 'MongoDB connection error'));

    const ready = conn
      .asPromise()
      .then(() => {
        log?.info('MongoDB connected');
        return conn;
      })
      .catch((err) => {
        this.#connections.delete(clusterId);
        throw err;
      });

    this.#connections.set(clusterId, ready);
    return ready;
  }

  async ping(clusterId = 'primary') {
    const conn = await this.connect(clusterId);
    await conn.db.admin().ping();
  }

  async closeAll() {
    const pending = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(
      pending.map((p) => p.then((c) => c.close()).catch(() => undefined)),
    );
  }
}
