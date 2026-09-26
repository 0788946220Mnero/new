import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { A, B, closeAll, routing, setupManager } from './helpers.js';

after(closeAll);

const rejectsWith = (promise, status, code) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, status);
    assert.equal(err.code, code);
    return true;
  });

describe('TenantDatabaseManager — resolution', () => {
  test('resolves an active restaurant to its own database', async () => {
    const { manager } = setupManager();
    const ctx = await manager.resolveById(A);
    assert.equal(ctx.restaurantId, A);
    assert.equal(ctx.databaseName, 'restaurant_AAAAAAAA');
    assert.equal(ctx.db.name, 'restaurant_AAAAAAAA');
    assert.equal(ctx.models.Product.db.name, 'restaurant_AAAAAAAA');
    assert.ok(Object.isFrozen(ctx));
  });

  test('two restaurants never share a database handle or models', async () => {
    const { manager } = setupManager();
    const a = await manager.resolveById(A);
    const b = await manager.resolveById(B);
    assert.notEqual(a.db, b.db);
    assert.notEqual(a.models.Product, b.models.Product);
    assert.equal(b.models.Category.db.name, 'restaurant_BBBBBBBB');
  });

  test('reuses the same database handle (no new connection per request)', async () => {
    const { manager } = setupManager();
    const first = await manager.resolveById(A);
    const second = await manager.resolveById(A);
    assert.equal(first.db, second.db);
    assert.equal(first.models.Product, second.models.Product);
  });

  test('resolves by slug, normalizing case and spaces', async () => {
    const { manager } = setupManager();
    const ctx = await manager.resolveBySlug('  ALPHA ');
    assert.equal(ctx.restaurantId, A);
  });
});

describe('TenantDatabaseManager — refusals', () => {
  test('unknown restaurant -> 404', async () => {
    const { manager } = setupManager();
    await rejectsWith(manager.resolveById('rest_ZZZZZZZZ'), 404, 'TENANT_NOT_FOUND');
    await rejectsWith(manager.resolveBySlug('nope'), 404, 'TENANT_NOT_FOUND');
  });

  test('malformed ids and injection objects never reach the registry', async () => {
    const { manager, calls } = setupManager();
    for (const bad of [{ $ne: null }, ['rest_AAAAAAAA'], 'restaurant_registry', '', undefined]) {
      await rejectsWith(manager.resolveById(bad), 404, 'TENANT_NOT_FOUND');
      await rejectsWith(manager.resolveBySlug(bad), 404, 'TENANT_NOT_FOUND');
    }
    await rejectsWith(manager.resolveBySlug('admin'), 404, 'TENANT_NOT_FOUND');
    assert.equal(calls.byId, 0);
    assert.equal(calls.bySlug, 0);
  });

  test('suspended and archived -> 403; provisioning and failed -> 404', async () => {
    const { manager } = setupManager({
      rows: [
        routing('rest_SSSSSSSS', 'susp', { status: 'suspended' }),
        routing('rest_RRRRRRRR', 'arch', { status: 'archived' }),
        routing('rest_PPPPPPPP', 'prov', { status: 'provisioning' }),
        routing('rest_FFFFFFFF', 'fail', { status: 'failed' }),
      ],
    });
    await rejectsWith(manager.resolveById('rest_SSSSSSSS'), 403, 'TENANT_UNAVAILABLE');
    await rejectsWith(manager.resolveBySlug('arch'), 403, 'TENANT_UNAVAILABLE');
    await rejectsWith(manager.resolveById('rest_PPPPPPPP'), 404, 'TENANT_NOT_FOUND');
    await rejectsWith(manager.resolveBySlug('fail'), 404, 'TENANT_NOT_FOUND');
  });

  test('refuses a registry record pointing at the registry database', async () => {
    const { manager, calls } = setupManager({
      rows: [routing(A, 'alpha', { databaseName: 'restaurant_registry' })],
    });
    await rejectsWith(manager.resolveById(A), 500, 'TENANT_ROUTING_INVALID');
    assert.equal(calls.connect, 0);
  });

  test('refuses a registry record pointing at another restaurant database', async () => {
    const { manager, calls } = setupManager({
      rows: [routing(A, 'alpha', { databaseName: 'restaurant_BBBBBBBB' }), routing(B, 'beta')],
    });
    await rejectsWith(manager.resolveBySlug('alpha'), 500, 'TENANT_ROUTING_INVALID');
    assert.equal(calls.connect, 0);
  });

  test('unknown cluster fails closed', async () => {
    const { manager } = setupManager({ rows: [routing(A, 'alpha', { clusterId: 'eu9' })] });
    await assert.rejects(manager.resolveById(A), /Unknown clusterId/);
  });
});

describe('TenantDatabaseManager — caching', () => {
  test('caches routing within the TTL and refreshes after it', async () => {
    const { manager, calls, advance } = setupManager();
    await manager.resolveById(A);
    await manager.resolveById(A);
    assert.equal(calls.byId, 1);
    advance(30_001);
    await manager.resolveById(A);
    assert.equal(calls.byId, 2);
  });

  test('slug lookup also warms the id cache', async () => {
    const { manager, calls } = setupManager();
    await manager.resolveBySlug('alpha');
    await manager.resolveById(A);
    await manager.resolveBySlug('alpha');
    assert.equal(calls.bySlug, 1);
    assert.equal(calls.byId, 0);
  });

  test('suspension takes effect immediately after invalidate()', async () => {
    const { manager, data } = setupManager();
    await manager.resolveById(A);
    data.set(A, routing(A, 'alpha', { status: 'suspended' }));

    await manager.resolveById(A); // still cached
    manager.invalidate(A);
    await rejectsWith(manager.resolveById(A), 403, 'TENANT_UNAVAILABLE');
    await rejectsWith(manager.resolveBySlug('alpha'), 403, 'TENANT_UNAVAILABLE');
  });

  test('slug rename: old slug stops working, new slug works', async () => {
    const { manager, data } = setupManager();
    await manager.resolveBySlug('alpha');
    data.set(A, routing(A, 'alpha-new'));
    manager.invalidate(A);
    await rejectsWith(manager.resolveBySlug('alpha'), 404, 'TENANT_NOT_FOUND');
    assert.equal((await manager.resolveBySlug('alpha-new')).restaurantId, A);
  });

  test('unknown slugs are negatively cached for a short time', async () => {
    const { manager, calls, advance } = setupManager();
    await rejectsWith(manager.resolveBySlug('ghost'), 404, 'TENANT_NOT_FOUND');
    await rejectsWith(manager.resolveBySlug('ghost'), 404, 'TENANT_NOT_FOUND');
    assert.equal(calls.bySlug, 1);
    advance(10_001);
    await rejectsWith(manager.resolveBySlug('ghost'), 404, 'TENANT_NOT_FOUND');
    assert.equal(calls.bySlug, 2);
  });

  test('invalidateSlug() lets a newly created restaurant resolve at once', async () => {
    const { manager, data } = setupManager();
    await rejectsWith(manager.resolveBySlug('gamma'), 404, 'TENANT_NOT_FOUND');
    data.set('rest_CCCCCCCC', routing('rest_CCCCCCCC', 'gamma'));
    manager.invalidateSlug('gamma');
    assert.equal((await manager.resolveBySlug('gamma')).restaurantId, 'rest_CCCCCCCC');
  });

  test('concurrent requests trigger a single registry lookup', async () => {
    const { manager, calls } = setupManager();
    const results = await Promise.all(Array.from({ length: 25 }, () => manager.resolveById(A)));
    assert.equal(calls.byId, 1);
    assert.ok(results.every((r) => r.db === results[0].db));
  });
});
