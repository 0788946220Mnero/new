// Verifies Atlas connectivity and creates registry collections/indexes.
// Usage: npm run db:check
import 'dotenv/config';
import { ClusterConnections } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { createRegistryModels } from '../src/registry/registry.models.js';
import { RegistryService } from '../src/registry/registry.service.js';

const config = loadEnv();
const clusters = new ClusterConnections({ uris: config.MONGODB_CLUSTERS });

try {
  for (const clusterId of Object.keys(config.MONGODB_CLUSTERS)) {
    await clusters.ping(clusterId);
    console.log(`✔ cluster "${clusterId}" reachable`);
  }

  const primary = await clusters.connect('primary');
  const registry = new RegistryService({
    models: createRegistryModels(primary, config.REGISTRY_DB_NAME),
  });
  await registry.ensureIndexes();
  console.log(`✔ registry "${config.REGISTRY_DB_NAME}" collections and indexes ready`);

  const { Restaurant } = registry.models;
  const counts = await Restaurant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  console.log('✔ restaurants by status:', Object.fromEntries(counts.map((c) => [c._id, c.n])));

  try {
    const { databases } = await primary.db.admin().listDatabases({ nameOnly: true });
    const tenantDbs = databases.filter((d) => /^restaurant_[2-9A-HJ-NP-Z]{8}$/.test(d.name));
    console.log(`✔ tenant databases on primary: ${tenantDbs.length}`);
  } catch {
    console.log('ℹ could not list databases (user lacks listDatabases) — not required at runtime');
  }
} catch (err) {
  console.error('✘ database check failed:', err.message);
  process.exitCode = 1;
} finally {
  await clusters.closeAll();
}
