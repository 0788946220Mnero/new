import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { startHarness } from './harness.js';

const ADMIN = 'ninja@mero.com';
const PW = 'Owner-Password-2026';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(100, 2)]);

describe('Images, settings and the public menu', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let admin;
  let A;
  let B;
  let viewer;
  let grills;
  let burger;

  const as = (token) => ({
    get: (p) => request(h.app).get(p).set('Authorization', `Bearer ${token}`),
    post: (p, b) => request(h.app).post(p).set('Authorization', `Bearer ${token}`).send(b),
    patch: (p, b) => request(h.app).patch(p).set('Authorization', `Bearer ${token}`).send(b),
    del: (p) => request(h.app).delete(p).set('Authorization', `Bearer ${token}`),
    upload: (p, buf, name = 'photo.png', type = 'image/png') =>
      request(h.app).put(p).set('Authorization', `Bearer ${token}`).attach('file', buf, { filename: name, contentType: type }),
  });
  const pub = (slug) => request(h.app).get(`/api/public/menu/${slug}`);

  async function restaurant(slug, email, limits) {
    const res = await request(h.app).post('/api/platform/restaurants').set('Authorization', `Bearer ${admin}`)
      .send({ name: `مطعم ${slug}`, slug, owner: { name: 'O', email }, ...(limits ? { limits } : {}) });
    const token = res.body.data.owner.setupUrl.split('#token=')[1];
    const s = await request(h.app).post('/api/auth/setup-password').set('X-Requested-With', 'fetch').send({ token, password: PW });
    return { ...res.body.data.restaurant, token: s.body.data.accessToken };
  }

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(ADMIN, 'Initial-Password-123');
    ({ token: admin } = await h.enrollSuperAdmin(ADMIN, 'Initial-Password-123', 'Changed-Password-456!'));
    A = await restaurant('pub-a', 'owner@pub-a.jo');
    B = await restaurant('pub-b', 'owner@pub-b.jo', { maxImageSizeMB: 1 });
    grills = (await as(A.token).post('/api/categories', { name: { ar: 'مشاوي', en: 'Grills' } })).body.data;
    burger = (await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'برجر' }, price: 3.5 })).body.data;

    const inv = await as(A.token).post('/api/users', { name: 'V', email: 'v@pub-a.jo', permissions: ['menu.view'] });
    const s = await request(h.app).post('/api/auth/setup-password').set('X-Requested-With', 'fetch')
      .send({ token: inv.body.data.setup.setupUrl.split('#token=')[1], password: 'Viewer-Password-2026' });
    viewer = s.body.data.accessToken;
  });
  after(() => h?.stop());

  // --------------------------------------------------------------- uploads
  test('upload a product image into the restaurant\'s own folder', async () => {
    const res = await as(A.token).upload(`/api/products/${burger.id}/image`, PNG);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.image.url, /^https:\/\/images\.test\/w_1200\//);
    assert.match(res.body.data.image.thumb, /w_400/);
    const keys = [...h.storage.files.keys()];
    assert.equal(keys.length, 1);
    assert.ok(keys[0].startsWith(`restaurants/${A.restaurantId}/products/`), keys[0]);
  });

  test('replacing an image deletes the old one; JPG and WebP are accepted', async () => {
    const before = [...h.storage.files.keys()];
    await as(A.token).upload(`/api/products/${burger.id}/image`, JPG, 'x.jpg', 'image/jpeg');
    const after = [...h.storage.files.keys()];
    assert.equal(after.length, 1);
    assert.notEqual(after[0], before[0]);
    assert.ok(after[0].endsWith('.jpg'));
    const webp = await as(A.token).upload(`/api/products/${burger.id}/image`, WEBP, 'x.webp', 'image/webp');
    assert.equal(webp.status, 200);
    assert.ok([...h.storage.files.keys()][0].endsWith('.webp'));
  });

  test('the real file content decides — disguised files are rejected', async () => {
    const attacks = [
      ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'evil.png', 'image/png'],
      ['<html><script>alert(1)</script></html>', 'page.jpg', 'image/jpeg'],
      ['GIF89a' + 'x'.repeat(50), 'anim.gif', 'image/gif'],
      ['%PDF-1.4 ' + 'x'.repeat(50), 'doc.png', 'image/png'],
    ];
    const count = h.storage.files.size;
    for (const [content, name, type] of attacks) {
      const res = await as(A.token).upload(`/api/products/${burger.id}/image`, Buffer.from(content), name, type);
      assert.equal(res.status, 400, name);
      assert.equal(res.body.code, 'INVALID_IMAGE');
    }
    assert.equal(h.storage.files.size, count, 'nothing was stored');
  });

  test('missing file and per-restaurant size limit', async () => {
    const none = await request(h.app).put(`/api/products/${burger.id}/image`).set('Authorization', `Bearer ${A.token}`);
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'NO_FILE');

    const cat = (await as(B.token).post('/api/categories', { name: { ar: 'x' } })).body.data;
    const prod = (await as(B.token).post('/api/products', { categoryId: cat.id, name: { ar: 'x' }, price: 1 })).body.data;
    const big = Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]);
    const res = await as(B.token).upload(`/api/products/${prod.id}/image`, big);
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'FILE_TOO_LARGE');
    assert.equal(res.body.details.maxMB, 1);
  });

  test('restaurant B cannot upload to or remove restaurant A images', async () => {
    const count = h.storage.files.size;
    assert.equal((await as(B.token).upload(`/api/products/${burger.id}/image`, PNG)).status, 404);
    assert.equal((await as(B.token).del(`/api/products/${burger.id}/image`)).status, 404);
    assert.equal((await as(B.token).upload(`/api/categories/${grills.id}/image`, PNG)).status, 404);
    assert.equal(h.storage.files.size, count);
    assert.ok((await as(A.token).get(`/api/products/${burger.id}`)).body.data.image, 'A image untouched');
  });

  test('uploading needs images.upload', async () => {
    const res = await as(viewer).upload(`/api/products/${burger.id}/image`, PNG);
    assert.equal(res.status, 403);
  });

  test('deleting a product also deletes its image', async () => {
    const tmp = (await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'مؤقت' }, price: 1 })).body.data;
    await as(A.token).upload(`/api/products/${tmp.id}/image`, PNG);
    const count = h.storage.files.size;
    await as(A.token).del(`/api/products/${tmp.id}`);
    assert.equal(h.storage.files.size, count - 1);
  });

  // -------------------------------------------------------------- settings
  test('settings: read, update partially, logo upload', async () => {
    const get = await as(A.token).get('/api/settings');
    assert.equal(get.status, 200);
    assert.equal(get.body.data.info.name, 'مطعم pub-a', 'provisioning copied the name');
    assert.equal(get.body.data.imagesEnabled, true);

    const upd = await as(A.token).patch('/api/settings', {
      info: { phone: '06 555 1234', whatsapp: '0791234567', social: { instagram: 'https://instagram.com/puba' } },
      theme: { primaryColor: '#3E5A34', layout: 'list', font: 'Tajawal' },
      hideUnavailableProducts: true,
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.body.data.info.name, 'مطعم pub-a', 'partial update keeps other fields');
    assert.equal(upd.body.data.theme.layout, 'list');
    assert.equal(upd.body.data.theme.secondaryColor, '#F59E0B', 'untouched default');

    const logo = await as(A.token).upload('/api/settings/logo', PNG);
    assert.equal(logo.status, 200);
    assert.ok(logo.body.data.logo.url.includes(`restaurants/${A.restaurantId}/logo/`));
  });

  test('settings reject bad colors, unsafe links, unknown fields and fonts', async () => {
    for (const body of [
      { theme: { primaryColor: 'red' } },
      { theme: { primaryColor: '#FFF' } },
      { info: { social: { instagram: 'javascript:alert(1)' } } },
      { info: { social: { facebook: 'http://facebook.com/x' } } },
      { theme: { font: 'Comic Sans' } },
      { theme: { layout: 'carousel' } },
      { logo: { url: 'https://evil', publicId: 'x' } },
      { info: { $set: { name: 'x' } } },
    ]) {
      const res = await as(A.token).patch('/api/settings', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test('settings need settings.view / settings.update', async () => {
    assert.equal((await as(viewer).get('/api/settings')).status, 403);
    assert.equal((await as(viewer).patch('/api/settings', { language: 'en' })).status, 403);
  });

  // ------------------------------------------------------------ public menu
  test('public menu shows only what customers should see', async () => {
    const hidden = (await as(A.token).post('/api/categories', { name: { ar: 'مخفي' } })).body.data;
    await as(A.token).post('/api/products', { categoryId: hidden.id, name: { ar: 'سري' }, price: 9 });
    await as(A.token).patch(`/api/categories/${hidden.id}`, { isVisible: false });
    const empty = (await as(A.token).post('/api/categories', { name: { ar: 'فارغ' } })).body.data;
    const soldOut = (await as(A.token).post('/api/products', { categoryId: grills.id, name: { ar: 'نفد' }, price: 2 })).body.data;
    await as(A.token).post(`/api/products/${soldOut.id}/availability`, { isAvailable: false });

    const res = await pub('pub-a');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-cache');
    const etag = res.headers.etag;
    assert.ok(etag, 'ETag for cheap revalidation');
    const again = await request(h.app).get('/api/public/menu/pub-a').set('If-None-Match', etag);
    assert.equal(again.status, 304, 'unchanged menu -> 304 Not Modified');
    const names = res.body.data.categories.map((c) => c.name.ar);
    assert.ok(names.includes('مشاوي'));
    assert.ok(!names.includes('مخفي'), 'hidden category excluded');
    assert.ok(!names.includes('فارغ'), 'empty category excluded');
    const products = res.body.data.categories.flatMap((c) => c.products.map((p) => p.name.ar));
    assert.ok(!products.includes('نفد'), 'unavailable hidden when the setting is on');
    assert.ok(!products.includes('سري'));

    assert.equal(res.body.data.theme.font, 'Tajawal');
    assert.equal(res.body.data.restaurant.social.instagram, 'https://instagram.com/puba');
    assert.ok(res.body.data.restaurant.logo.url);
    void empty;
  });

  test('public menu never leaks internal data', async () => {
    // The restaurant id is part of image paths (restaurants/<id>/...) by design; it is not a
    // credential — tenant access never trusts ids from clients. Everything else must be absent.
    const text = JSON.stringify((await pub('pub-a')).body).replace(/https:\/\/images\.test\/[^"]+/g, 'IMG');
    for (const secret of ['databaseName', 'restaurant_', A.restaurantId, 'publicId', 'owner@pub-a.jo', 'sortOrder', 'passwordHash', 'limits', 'clusterId', 'userId']) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
  });

  test('changes appear on the public menu immediately (cache invalidation)', async () => {
    await pub('pub-a'); // warm cache
    await as(A.token).patch(`/api/products/${burger.id}`, { price: 4.25 });
    const p1 = (await pub('pub-a')).body.data.categories.flatMap((c) => c.products).find((p) => p.id === burger.id);
    assert.equal(p1.price, 4.25);

    await as(A.token).patch('/api/settings', { hideUnavailableProducts: false });
    const all = (await pub('pub-a')).body.data.categories.flatMap((c) => c.products);
    const sold = all.find((p) => p.name.ar === 'نفد');
    assert.ok(sold, 'unavailable products now listed');
    assert.equal(sold.isAvailable, false);
  });

  test('suspended, unknown and malicious slugs', async () => {
    await request(h.app).post(`/api/platform/restaurants/${A.restaurantId}/suspend`).set('Authorization', `Bearer ${admin}`);
    const s = await pub('pub-a');
    assert.equal(s.status, 403);
    assert.equal(s.body.code, 'TENANT_UNAVAILABLE');
    await request(h.app).post(`/api/platform/restaurants/${A.restaurantId}/activate`).set('Authorization', `Bearer ${admin}`);
    assert.equal((await pub('pub-a')).status, 200);

    for (const slug of ['nope-nope', 'admin', '..%2F..%2Fetc', '%24ne', 'a'.repeat(80), 'restaurant_registry']) {
      assert.equal((await pub(slug)).status, 404, slug);
    }
    const q = await request(h.app).get('/api/public/menu/pub-a?slug[$ne]=x');
    assert.equal(q.status, 200);
    assert.equal(q.body.data.restaurant.slug, 'pub-a');
  });
});
