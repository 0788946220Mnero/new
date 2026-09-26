import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { databaseNameFor, RESTAURANT_ID_REGEX } from '../../src/tenants/tenantNaming.js';
import { startHarness } from './harness.js';

const EMAIL = 'ninja@mero.com';

describe('Restaurant provisioning & management', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let token;
  const api = () => ({
    get: (url) => request(h.app).get(url).set('Authorization', `Bearer ${token}`),
    post: (url, body) => request(h.app).post(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url, body) => request(h.app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
    del: (url) => request(h.app).delete(url).set('Authorization', `Bearer ${token}`),
  });
  let n = 0;
  const newRestaurant = (extra = {}) => {
    n += 1;
    return { name: `Test Grill ${n}`, owner: { name: 'Owner', email: `owner${n}@example.com` }, ...extra };
  };

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(EMAIL, 'Initial-Password-123');
    ({ token } = await h.enrollSuperAdmin(EMAIL, 'Initial-Password-123', 'Changed-Password-456!'));
  });
  after(() => h?.stop());
  beforeEach(() => {
    delete h.hooks.beforeStep;
  });

  test('requires authentication', async () => {
    const res = await request(h.app).post('/api/platform/restaurants').send(newRestaurant());
    assert.equal(res.status, 401);
  });

  test('creates a restaurant end to end with no manual database work', async () => {
    const res = await api().post('/api/platform/restaurants', {
      name: 'مطعم ديار',
      slug: 'diar-test',
      phone: '+962 7 9000 0000',
      address: 'Amman',
      owner: { name: 'Marwan', email: 'Owner.Diar@Example.com', phone: '0790000000' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { restaurant, owner } = res.body.data;

    assert.match(restaurant.restaurantId, RESTAURANT_ID_REGEX);
    assert.equal(restaurant.databaseName, databaseNameFor(restaurant.restaurantId));
    assert.equal(restaurant.status, 'active');
    assert.equal(restaurant.slug, 'diar-test');
    assert.equal(restaurant.mediaFolder, `restaurants/${restaurant.restaurantId}`);
    assert.deepEqual(Object.keys(restaurant.provisioningSteps).sort(), ['audit', 'collections', 'media', 'owner', 'settings']);
    assert.equal(owner.email, 'owner.diar@example.com');
    assert.match(owner.setupUrl, /^https:\/\/admin\.example\.com\/setup-password#token=rest_[A-Z0-9]{8}\.[\w-]{40,}$/);

    // Dedicated database with exactly the 5 tenant collections
    assert.ok((await h.databaseNames()).includes(restaurant.databaseName));
    const db = h.tenantDb(restaurant.databaseName);
    const collections = (await db.db.listCollections().toArray()).map((c) => c.name).sort();
    assert.deepEqual(collections, ['auditLogs', 'categories', 'products', 'settings', 'users']);
    const userIndexes = await db.db.collection('users').indexes();
    assert.ok(userIndexes.some((i) => i.key.email === 1 && i.unique));

    // Owner, directory, settings, audit
    const users = await db.db.collection('users').find().toArray();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'Owner');
    assert.equal(users[0].status, 'invited');
    assert.equal(users[0].passwordHash, undefined);
    const rawToken = owner.setupUrl.split('.').pop();
    assert.equal(users[0].setupTokenHash.length, 64);
    assert.ok(!users[0].setupTokenHash.includes(rawToken), 'setup token must be stored hashed');

    const dir = await h.models.UserDirectory.findOne({ email: 'owner.diar@example.com' }).lean();
    assert.equal(dir.restaurantId, restaurant.restaurantId);
    assert.equal(dir.userId, String(users[0]._id));

    const settings = await db.db.collection('settings').findOne({ _id: 'main' });
    assert.equal(settings.info.name, 'مطعم ديار');
    assert.equal(settings.theme.layout, 'grid');

    assert.ok(await db.db.collection('auditLogs').findOne({ action: 'restaurant.provisioned' }));
    const platformEvents = (await h.models.PlatformAuditLog.find({ restaurantId: restaurant.restaurantId }).lean()).map((l) => l.action);
    assert.ok(platformEvents.includes('restaurant.created'));
    assert.ok(platformEvents.includes('restaurant.provisioned'));

    // Public menu resolution works immediately
    const ctx = await h.tenantManager.resolveBySlug('diar-test');
    assert.equal(ctx.restaurantId, restaurant.restaurantId);
  });

  test('two restaurants get separate databases and separate owners', async () => {
    const a = (await api().post('/api/platform/restaurants', newRestaurant())).body.data.restaurant;
    const b = (await api().post('/api/platform/restaurants', newRestaurant())).body.data.restaurant;
    assert.notEqual(a.databaseName, b.databaseName);
    const usersA = await h.tenantDb(a.databaseName).db.collection('users').find().toArray();
    const usersB = await h.tenantDb(b.databaseName).db.collection('users').find().toArray();
    assert.equal(usersA.length, 1);
    assert.equal(usersB.length, 1);
    assert.notEqual(usersA[0].email, usersB[0].email);
  });

  test('generates slugs: latin names are slugified, Arabic names get menu-xxxx', async () => {
    const ar = await api().post('/api/platform/restaurants', newRestaurant({ name: 'شاورما الريم' }));
    assert.match(ar.body.data.restaurant.slug, /^menu-[a-z2-9]{8}$/);

    const b1 = await api().post('/api/platform/restaurants', newRestaurant({ name: 'Burger House!' }));
    const b2 = await api().post('/api/platform/restaurants', newRestaurant({ name: 'Burger House' }));
    assert.equal(b1.body.data.restaurant.slug, 'burger-house');
    assert.match(b2.body.data.restaurant.slug, /^burger-house-[a-z2-9]{4}$/);
  });

  test('client cannot choose database, id or status', async () => {
    const stripped = await api().post('/api/platform/restaurants', newRestaurant({
      databaseName: 'restaurant_registry',
      restaurantId: 'rest_AAAAAAAA',
    }));
    assert.equal(stripped.status, 201);
    assert.notEqual(stripped.body.data.restaurant.restaurantId, 'rest_AAAAAAAA');
    assert.equal(stripped.body.data.restaurant.databaseName, databaseNameFor(stripped.body.data.restaurant.restaurantId));

    const before = await h.models.Restaurant.countDocuments();
    const withStatus = await api().post('/api/platform/restaurants', newRestaurant({ status: 'active', clusterId: 'x' }));
    assert.equal(withStatus.status, 400);
    assert.equal(withStatus.body.code, 'VALIDATION_ERROR');
    assert.equal(await h.models.Restaurant.countDocuments(), before);
  });

  test('rejects duplicate slug, duplicate owner email and reserved slugs — without side effects', async () => {
    const before = await h.models.Restaurant.countDocuments();

    const dupSlug = await api().post('/api/platform/restaurants', newRestaurant({ slug: 'diar-test' }));
    assert.equal(dupSlug.status, 409);
    assert.equal(dupSlug.body.code, 'SLUG_TAKEN');

    const dupEmail = await api().post('/api/platform/restaurants', { name: 'X', owner: { name: 'O', email: 'owner.diar@example.com' } });
    assert.equal(dupEmail.status, 409);
    assert.equal(dupEmail.body.code, 'EMAIL_IN_USE');

    const reserved = await api().post('/api/platform/restaurants', newRestaurant({ slug: 'admin' }));
    assert.equal(reserved.status, 400);
    assert.equal(reserved.body.code, 'INVALID_SLUG');

    assert.equal(await h.models.Restaurant.countDocuments(), before);
  });

  test('failure mid-way -> status failed with a safe message; retry completes it', async () => {
    h.hooks.beforeStep = (step) => {
      if (step === 'settings') throw new Error('secret internal detail');
    };
    const res = await api().post('/api/platform/restaurants', newRestaurant({ slug: 'retry-me' }));
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'PROVISIONING_FAILED');
    assert.doesNotMatch(JSON.stringify(res.body), /secret internal detail/);
    const { restaurantId } = res.body.details;

    const failed = await h.models.Restaurant.findOne({ restaurantId }).lean();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.provisioningError, 'Step "settings" failed');
    assert.deepEqual(Object.keys(failed.provisioningSteps).sort(), ['collections', 'owner']);
    await assert.rejects(h.tenantManager.resolveBySlug('retry-me'), (e) => e.statusCode === 404);

    delete h.hooks.beforeStep;
    const retried = await api().post(`/api/platform/restaurants/${restaurantId}/retry-provisioning`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.data.restaurant.status, 'active');

    const users = await h.tenantDb(failed.databaseName).db.collection('users').countDocuments();
    assert.equal(users, 1, 'retry must not duplicate the owner');
    assert.equal(await h.models.UserDirectory.countDocuments({ restaurantId }), 1);
    assert.equal((await h.tenantManager.resolveBySlug('retry-me')).restaurantId, restaurantId);

    const again = await api().post(`/api/platform/restaurants/${restaurantId}/retry-provisioning`);
    assert.equal(again.status, 409);
  });

  test('failed restaurant can be cleaned up completely, freeing its slug and owner email', async () => {
    h.hooks.beforeStep = (step) => {
      if (step === 'media') throw new Error('boom');
    };
    const body = { name: 'Cleanup Cafe', slug: 'cleanup-cafe', owner: { name: 'O', email: 'cleanup@example.com' } };
    const res = await api().post('/api/platform/restaurants', body);
    assert.equal(res.status, 500);
    const { restaurantId } = res.body.details;
    const databaseName = databaseNameFor(restaurantId);
    assert.ok((await h.databaseNames()).includes(databaseName));

    const del = await api().del(`/api/platform/restaurants/${restaurantId}`);
    assert.equal(del.status, 200);
    assert.equal(await h.models.Restaurant.countDocuments({ restaurantId }), 0);
    assert.equal(await h.models.UserDirectory.countDocuments({ restaurantId }), 0);
    assert.ok(!(await h.databaseNames()).includes(databaseName));

    delete h.hooks.beforeStep;
    const recreated = await api().post('/api/platform/restaurants', body);
    assert.equal(recreated.status, 201);
  });

  test('active restaurants cannot be deleted', async () => {
    const r = (await api().post('/api/platform/restaurants', newRestaurant())).body.data.restaurant;
    const res = await api().del(`/api/platform/restaurants/${r.restaurantId}`);
    assert.equal(res.status, 409);
  });

  test('suspend / activate / archive take effect immediately', async () => {
    const r = (await api().post('/api/platform/restaurants', newRestaurant({ slug: 'status-test' }))).body.data.restaurant;
    const url = `/api/platform/restaurants/${r.restaurantId}`;

    assert.equal((await api().post(`${url}/suspend`)).body.data.status, 'suspended');
    await assert.rejects(h.tenantManager.resolveBySlug('status-test'), (e) => e.statusCode === 403);
    assert.equal((await api().post(`${url}/suspend`)).status, 409);

    assert.equal((await api().post(`${url}/activate`)).body.data.status, 'active');
    assert.equal((await h.tenantManager.resolveBySlug('status-test')).restaurantId, r.restaurantId);

    assert.equal((await api().post(`${url}/archive`)).body.data.status, 'archived');
    await assert.rejects(h.tenantManager.resolveById(r.restaurantId), (e) => e.statusCode === 403);
    assert.equal((await api().post(`${url}/activate`)).body.data.status, 'active');

    assert.equal((await api().post(`${url}/delete-everything`)).status, 404);
  });

  test('reset owner access issues a new link and invalidates the old one', async () => {
    const created = (await api().post('/api/platform/restaurants', newRestaurant())).body.data;
    const { restaurantId, databaseName } = created.restaurant;
    const users = h.tenantDb(databaseName).db.collection('users');
    await users.updateOne({}, { $set: { passwordHash: 'x', status: 'active' } });
    const before = (await users.findOne()).setupTokenHash;

    const res = await api().post(`/api/platform/restaurants/${restaurantId}/reset-owner-access`);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.data.setupUrl, created.owner.setupUrl);
    const owner = await users.findOne();
    assert.notEqual(owner.setupTokenHash, before);
    assert.equal(owner.status, 'invited');
    assert.equal(owner.passwordHash, undefined);
  });

  test('update: slug change, limits, conflicts, and strict fields', async () => {
    const r = (await api().post('/api/platform/restaurants', newRestaurant({ slug: 'old-slug' }))).body.data.restaurant;
    const url = `/api/platform/restaurants/${r.restaurantId}`;
    await h.tenantManager.resolveBySlug('old-slug');

    const upd = await api().patch(url, { slug: 'new-slug', limits: { maxProducts: 50 }, name: 'Renamed' });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.data.slug, 'new-slug');
    assert.equal(upd.body.data.limits.maxProducts, 50);
    await assert.rejects(h.tenantManager.resolveBySlug('old-slug'), (e) => e.statusCode === 404);
    assert.equal((await h.tenantManager.resolveBySlug('new-slug')).restaurantId, r.restaurantId);

    assert.equal((await api().patch(url, { slug: 'diar-test' })).status, 409);
    assert.equal((await api().patch(url, { status: 'active' })).status, 400);
    assert.equal((await api().patch(url, { databaseName: 'restaurant_registry' })).body.data.databaseName, r.databaseName);
  });

  test('stats counts restaurants by status', async () => {
    const res = await api().get('/api/platform/stats');
    assert.equal(res.status, 200);
    const { total, byStatus } = res.body.data;
    assert.deepEqual(Object.keys(byStatus).sort(), ['active', 'archived', 'failed', 'provisioning', 'suspended']);
    assert.equal(total, await h.models.Restaurant.countDocuments());
    assert.equal(byStatus.active, await h.models.Restaurant.countDocuments({ status: 'active' }));
  });

  test('list, search, filter, detail and audit endpoints', async () => {
    const list = await api().get('/api/platform/restaurants?limit=5');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.total >= 5);
    assert.equal(list.body.data.items.length, 5);

    const byOwner = await api().get('/api/platform/restaurants?q=owner.diar@example');
    assert.equal(byOwner.body.data.items[0].slug, 'diar-test');
    const byArabic = await api().get(`/api/platform/restaurants?q=${encodeURIComponent('ديار')}`);
    assert.equal(byArabic.body.data.items[0].slug, 'diar-test');
    const regexAttack = await api().get(`/api/platform/restaurants?q=${encodeURIComponent('.*(a+)+$')}`);
    assert.equal(regexAttack.status, 200);
    assert.equal(regexAttack.body.data.total, 0);

    const failed = await api().get('/api/platform/restaurants?status=active');
    assert.ok(failed.body.data.items.every((i) => i.status === 'active'));
    assert.equal((await api().get('/api/platform/restaurants?status=bogus')).status, 400);

    const serialized = JSON.stringify(list.body);
    assert.doesNotMatch(serialized, /passwordHash|setupToken/);

    const id = byOwner.body.data.items[0].restaurantId;
    const detail = await api().get(`/api/platform/restaurants/${id}`);
    assert.deepEqual(detail.body.data.stats, { products: 0, categories: 0 });
    assert.equal((await api().get('/api/platform/restaurants/rest_ZZZZZZZZ')).status, 404);
    assert.equal((await api().get('/api/platform/restaurants/not-an-id')).status, 404);

    const logs = await api().get(`/api/platform/audit-logs?restaurant=${id}`);
    assert.ok(logs.body.data.items.length >= 2);
    assert.ok(logs.body.data.items.every((l) => l.restaurantId === id));
  });
});
