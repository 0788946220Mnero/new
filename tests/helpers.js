import mongoose from 'mongoose';
import pino from 'pino';
import { TenantDatabaseManager } from '../src/tenants/tenantDatabaseManager.js';
import { databaseNameFor } from '../src/tenants/tenantNaming.js';

export const silentLogger = pino({ level: 'silent' });

export const A = 'rest_AAAAAAAA';
export const B = 'rest_BBBBBBBB';

export function routing(restaurantId, slug, extra = {}) {
  return {
    restaurantId,
    slug,
    databaseName: databaseNameFor(restaurantId),
    clusterId: 'primary',
    status: 'active',
    ...extra,
  };
}

const openConnections = [];
export async function closeAll() {
  await Promise.allSettled(openConnections.splice(0).map((c) => c.close()));
}

/**
 * Real TenantDatabaseManager + real Mongoose useDb/model compilation,
 * with an in-memory registry and an unopened connection (no network, no queries).
 */
export function setupManager({ rows = [routing(A, 'alpha'), routing(B, 'beta')] } = {}) {
  const calls = { byId: 0, bySlug: 0, connect: 0 };
  const data = new Map(rows.map((r) => [r.restaurantId, r]));

  const registry = {
    async findTenantRoutingById(id) {
      calls.byId += 1;
      return data.get(id) ?? null;
    },
    async findTenantRoutingBySlug(slug) {
      calls.bySlug += 1;
      for (const r of data.values()) if (r.slug === slug) return r;
      return null;
    },
  };

  const conn = mongoose.createConnection();
  openConnections.push(conn);
  const clusters = {
    async connect(clusterId) {
      calls.connect += 1;
      if (clusterId !== 'primary') throw new Error(`Unknown clusterId "${clusterId}"`);
      return conn;
    },
    async ping() {},
  };

  let clock = 1_000_000;
  const manager = new TenantDatabaseManager({
    registry,
    clusters,
    registryDbName: 'restaurant_registry',
    cacheTtlMs: 30_000,
    notFoundTtlMs: 10_000,
    now: () => clock,
    logger: silentLogger,
  });

  return {
    manager,
    calls,
    data,
    clusters,
    advance: (ms) => {
      clock += ms;
    },
  };
}
