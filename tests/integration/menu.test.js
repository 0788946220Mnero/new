import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { startHarness } from './harness.js';

const ADMIN = 'ninja@mero.com';
const PW = 'Owner-Password-2026';

describe('Menu: categories and products', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let admin;
  let A; // { restaurantId, databaseName, token }
  let B;
  let viewer; // employee with menu.view only

  const as = (token) => ({
    get: (p) => request(h.app).get(p).set('Authorization', `Bearer ${token}`),
    post: (p, b) => request(h.app).post(p).set('Authorization', `Bearer ${token}`).send(b),
    put: (p, b) => request(h.app).put(p).set('Authorization', `Bearer ${token}`).send(b),
    patch: (p, b) => request(h.app).patch(p).set('Authorization', `Bearer ${token}`).send(b),
    del: (p) => request(h.app).delete(p).set('Authorization', `Bearer ${token}`),
  });

  async function restaurantWithOwner(slug, email, limits) {
    const res = await request(h.app)
      .post('/api/platform/restaurants')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: slug, slug, owner: { name: 'O', email }, ...(limits ? { limits } : {}) });
    const token = res.body.data.owner.setupUrl.split('#token=')[1];
    const setup = await request(h.app).post('/api/auth/setup-password').set('X-Requested-With', 'fetch').send({ token, password: PW });
    return { ...res.body.data.restaurant, token: setup.body.data.accessToken };
  }

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(ADMIN, 'Initial-Password-123');
    ({ token: admin } = await h.enrollSuperAdmin(ADMIN, 'Initial-Password-123', 'Changed-Password-456!'));
    A = await restaurantWithOwner('menu-a', 'owner@menu-a.jo');
    B = await restaurantWithOwner('menu-b', 'owner@menu-b.jo', { maxCategories: 2, maxProducts: 2 });

    const invite = await as(A.token).post('/api/users', { name: 'Viewer', email: 'viewer@menu-a.jo', permissions: ['menu.view', 'products.toggleAvailability'] });
    const setup = await request(h.app).post('/api/auth/setup-password').set('X-Requested-With', 'fetch')
      .send({ token: invite.body.data.setup.setupUrl.split('#token=')[1], password: 'Viewer-Password-2026' });
    viewer = setup.body.data.accessToken;
  });
  after(() => h?.stop());

  let grills;
  let drinks;
  let burger;

  test('create categories in order', async () => {
    const g = await as(A.token).post('/api/categories', { name: { ar: 'مشاوي', en: 'Grills' } });
    const d = await as(A.token).post('/api/categories', { name: { ar: 'مشروبات', en: '' } });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    grills = g.body.data;
    drinks = d.body.data;
    assert.equal(grills.sortOrder, 0);
    assert.equal(drinks.sortOrder, 1);
    assert.equal(drinks.name.en, undefined, 'empty English name is not stored');

    const list = await as(A.token).get('/api/categories');
    assert.deepEqual(list.body.data.map((c) => c.name.ar), ['مشاوي', 'مشروبات']);
  });

  test('Arabic name is required and unknown fields are rejected', async () => {
    assert.equal((await as(A.token).post('/api/categories', { name: { ar: '' } })).status, 400);
    assert.equal((await as(A.token).post('/api/categories', { name: { ar: 'x' }, sortOrder: 99 })).status, 400);
  });

  test('create products with a price or with sizes', async () => {
    const res = await as(A.token).post('/api/products', {
      categoryId: grills.id,
      name: { ar: 'برجر لحم', en: 'Beef burger' },
      description: { ar: 'لحم بلدي مع جبنة' },
      price: 3.5,
      badges: ['popular', 'popular'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    burger = res.body.data;
    assert.equal(burger.price, 3.5);
    assert.deepEqual(burger.badges, ['popular']);
    assert.equal(burger.isAvailable, true);

    const sized = await as(A.token).post('/api/products', {
      categoryId: drinks.id,
      name: { ar: 'عصير برتقال' },
      variants: [{ name: { ar: 'صغير' }, price: 1 }, { name: { ar: 'كبير' }, price: 1.75 }],
    });
    assert.equal(sized.status, 201);
    assert.equal(sized.body.data.price, null);
    assert.equal(sized.body.data.variants.length, 2);

    const noPrice = await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'بلا سعر' } });
    assert.equal(noPrice.status, 400);
    assert.equal(noPrice.body.code, 'PRICE_REQUIRED');

    for (const bad of [-1, 1.2345, 100001]) {
      assert.equal((await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'x' }, price: bad })).status, 400, `price ${bad}`);
    }
    assert.equal((await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'x' }, price: '3.5' })).status, 400, 'price must be a number');
  });

  test('price changes are audited with old and new values', async () => {
    const res = await as(A.token).patch(`/api/products/${burger.id}`, { price: 3.75 });
    assert.equal(res.body.data.price, 3.75);
    const log = await h.tenantDb(A.databaseName).db.collection('auditLogs').findOne({ action: 'product.price_changed' });
    assert.equal(log.metadata.oldPrice, 3.5);
    assert.equal(log.metadata.newPrice, 3.75);
    assert.equal(log.resourceId, burger.id);
  });

  test('a product cannot end up without any price', async () => {
    const res = await as(A.token).patch(`/api/products/${burger.id}`, { price: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PRICE_REQUIRED');
    const switched = await as(A.token).patch(`/api/products/${burger.id}`, { price: null, variants: [{ name: { ar: 'دبل' }, price: 5 }] });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.data.price, null);
    await as(A.token).patch(`/api/products/${burger.id}`, { price: 3.75, variants: [] });
  });

  test('reorder requires every item exactly once', async () => {
    const p2 = (await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'شيش طاووق' }, price: 4 })).body.data;
    const ok = await as(A.token).put('/api/products/order', { categoryId: grills.id, ids: [p2.id, burger.id] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.data.map((p) => p.id), [p2.id, burger.id]);

    for (const ids of [[p2.id], [p2.id, p2.id], [p2.id, burger.id, drinks.id]]) {
      const bad = await as(A.token).put('/api/products/order', { categoryId: grills.id, ids });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'INVALID_ORDER');
    }

    const cats = await as(A.token).put('/api/categories/order', { ids: [drinks.id, grills.id] });
    assert.deepEqual(cats.body.data.map((c) => c.id), [drinks.id, grills.id]);
  });

  test('deleting a category with products requires moving them', async () => {
    const extra = (await as(A.token).post('/api/categories', { name: { ar: 'مؤقت' } })).body.data;
    await as(A.token).post('/api/products', { categoryId: extra.id, name: { ar: 'منتج مؤقت' }, price: 1 });

    const blocked = await as(A.token).del(`/api/categories/${extra.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'CATEGORY_NOT_EMPTY');
    assert.equal(blocked.body.details.productCount, 1);

    assert.equal((await as(A.token).del(`/api/categories/${extra.id}?moveTo=${extra.id}`)).status, 400);

    const moved = await as(A.token).del(`/api/categories/${extra.id}?moveTo=${grills.id}`);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.movedProducts, 1);
    const inGrills = await as(A.token).get(`/api/products?categoryId=${grills.id}`);
    assert.equal(inGrills.body.data.at(-1).name.ar, 'منتج مؤقت', 'moved products go to the end');
  });

  test('restaurant B cannot see or touch restaurant A menu, even with real ids', async () => {
    const list = await as(B.token).get('/api/categories');
    assert.deepEqual(list.body.data, []);

    const attempts = [
      as(B.token).get(`/api/products/${burger.id}`),
      as(B.token).patch(`/api/products/${burger.id}`, { price: 0 }),
      as(B.token).del(`/api/products/${burger.id}`),
      as(B.token).post(`/api/products/${burger.id}/availability`, { isAvailable: false }),
      as(B.token).patch(`/api/categories/${grills.id}`, { name: { ar: 'hacked' } }),
      as(B.token).del(`/api/categories/${grills.id}`),
      as(B.token).get(`/api/products?categoryId=${grills.id}`),
    ];
    for (const res of await Promise.all(attempts)) assert.equal(res.status, 404, JSON.stringify(res.body));

    // B cannot create a product inside A's category either.
    const cross = await as(B.token).post('/api/products', { categoryId: grills.id, name: { ar: 'x' }, price: 1 });
    assert.equal(cross.status, 400);
    assert.equal(cross.body.code, 'INVALID_CATEGORY');

    const stillThere = await as(A.token).get(`/api/products/${burger.id}`);
    assert.equal(stillThere.body.data.price, 3.75);
    assert.equal(stillThere.body.data.isAvailable, true);
  });

  test('permissions: a viewer can read and toggle availability, nothing else', async () => {
    assert.equal((await as(viewer).get('/api/categories')).status, 200);
    assert.equal((await as(viewer).get('/api/products')).status, 200);
    const off = await as(viewer).post(`/api/products/${burger.id}/availability`, { isAvailable: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.isAvailable, false);

    for (const res of await Promise.all([
      as(viewer).post('/api/categories', { name: { ar: 'x' } }),
      as(viewer).patch(`/api/products/${burger.id}`, { price: 1 }),
      as(viewer).del(`/api/products/${burger.id}`),
      as(viewer).put('/api/categories/order', { ids: [grills.id, drinks.id] }),
    ])) {
      assert.equal(res.status, 403);
    }
    await as(A.token).post(`/api/products/${burger.id}/availability`, { isAvailable: true });
  });

  test('per-restaurant limits set by the Super Admin are enforced', async () => {
    const c1 = await as(B.token).post('/api/categories', { name: { ar: '1' } });
    await as(B.token).post('/api/categories', { name: { ar: '2' } });
    const c3 = await as(B.token).post('/api/categories', { name: { ar: '3' } });
    assert.equal(c3.status, 409);
    assert.equal(c3.body.code, 'CATEGORY_LIMIT');

    const cid = c1.body.data.id;
    await as(B.token).post('/api/products', { categoryId: cid, name: { ar: 'a' }, price: 1 });
    await as(B.token).post('/api/products', { categoryId: cid, name: { ar: 'b' }, price: 1 });
    const p3 = await as(B.token).post('/api/products', { categoryId: cid, name: { ar: 'c' }, price: 1 });
    assert.equal(p3.status, 409);
    assert.equal(p3.body.code, 'PRODUCT_LIMIT');
    assert.equal(p3.body.details.limit, 2);
  });

  test('category list includes product counts; delete a product', async () => {
    const before = (await as(A.token).get('/api/categories')).body.data.find((c) => c.id === grills.id).productCount;
    assert.equal((await as(A.token).del(`/api/products/${burger.id}`)).status, 200);
    const after = (await as(A.token).get('/api/categories')).body.data.find((c) => c.id === grills.id).productCount;
    assert.equal(after, before - 1);
    assert.equal((await as(A.token).get(`/api/products/${burger.id}`)).status, 404);
  });

  test('super admin detail shows real content counts', async () => {
    const detail = await request(h.app).get(`/api/platform/restaurants/${A.restaurantId}`).set('Authorization', `Bearer ${admin}`);
    assert.ok(detail.body.data.stats.categories >= 2);
    assert.ok(detail.body.data.stats.products >= 2);
  });
});
