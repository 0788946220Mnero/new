import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { startHarness } from './harness.js';

const ADMIN = 'ninja@mero.com';
const DAY = 24 * 60 * 60 * 1000;
const body = (extra = {}) => ({
  restaurantName: 'Shawarma Corner',
  slug: 'shawarma-corner',
  ownerName: 'Ahmad',
  email: 'ahmad@corner.jo',
  phone: '0791234567',
  password: 'Owner-Password-2026',
  ...extra,
});

describe('Self sign-up with a 7-day trial', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let admin;
  let session;
  let restaurantId;

  const signup = (b) => request(h.app).post('/api/signup').set('X-Requested-With', 'fetch').send(b);
  const pub = (slug) => request(h.app).get(`/api/public/menu/${slug}`);
  const asOwner = (token) => ({
    get: (p) => request(h.app).get(p).set('Authorization', `Bearer ${token}`),
    post: (p, b) => request(h.app).post(p).set('Authorization', `Bearer ${token}`).send(b),
  });
  const platform = (method, path, b) => request(h.app)[method](`/api/platform${path}`).set('Authorization', `Bearer ${admin}`).send(b);

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(ADMIN, 'Initial-Password-123');
    ({ token: admin } = await h.enrollSuperAdmin(ADMIN, 'Initial-Password-123', 'Changed-Password-456!'));
  });
  after(() => h?.stop());

  test('an owner registers and is signed in immediately', async () => {
    const res = await signup(body());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.data.accessToken);
    assert.equal(res.body.data.user.role, 'Owner');
    assert.match([].concat(res.headers['set-cookie']).join(';'), /fm_rt=.*HttpOnly/i);
    const trialEnd = new Date(res.body.data.restaurant.trialEndsAt).getTime();
    assert.ok(Math.abs(trialEnd - (h.clock.now() + 7 * DAY)) < 60_000, 'trial ends in 7 days');
    session = res.body.data.accessToken;
    restaurantId = res.body.data.restaurant.restaurantId;

    const record = await h.models.Restaurant.findOne({ restaurantId }).lean();
    assert.equal(record.approved, false);
    assert.equal(record.signupSource, 'self');
    assert.equal(record.status, 'active');
    const log = await h.models.PlatformAuditLog.findOne({ action: 'restaurant.self_registered', restaurantId }).lean();
    assert.ok(log);
  });

  test('during the trial everything works', async () => {
    const cat = await asOwner(session).post('/api/categories', { name: { ar: 'شاورما' } });
    assert.equal(cat.status, 201);
    await asOwner(session).post('/api/products', { categoryId: cat.body.data.id, name: { ar: 'سندويش' }, price: 1 });
    assert.equal((await pub('shawarma-corner')).status, 200);
    const me = await asOwner(session).get('/api/auth/me');
    assert.ok(me.body.data.restaurant.trialEndsAt);
  });

  test('after 7 days the menu, the login and existing sessions stop', async () => {
    h.clock.advance(7 * DAY + 1000);
    const p = await pub('shawarma-corner');
    assert.equal(p.status, 403);
    assert.equal(p.body.code, 'TRIAL_EXPIRED');
    assert.equal((await asOwner(session).get('/api/categories')).status, 403);
    const login = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'fetch').send({ email: 'ahmad@corner.jo', password: 'Owner-Password-2026' });
    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'TRIAL_EXPIRED');
  });

  test('Super Admin sees it as pending and can extend the trial', async () => {
    const pending = await platform('get', '/restaurants?approval=pending');
    assert.deepEqual(pending.body.data.items.map((r) => r.restaurantId), [restaurantId]);
    const stats = await platform('get', '/stats');
    assert.equal(stats.body.data.approval.pending, 1);
    assert.equal(stats.body.data.approval.trialExpired, 1);

    const ext = await platform('post', `/restaurants/${restaurantId}/extend-trial`, { days: 3 });
    assert.equal(ext.status, 200);
    assert.ok(Math.abs(new Date(ext.body.data.trialEndsAt).getTime() - (h.clock.now() + 3 * DAY)) < 60_000, 'extended from now');
    assert.equal((await pub('shawarma-corner')).status, 200);
    assert.equal((await platform('post', `/restaurants/${restaurantId}/extend-trial`, { days: 0 })).status, 400);
  });

  test('approval makes it permanent; suspend still blocks it', async () => {
    const ok = await platform('post', `/restaurants/${restaurantId}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.approved, true);
    assert.equal(ok.body.data.trialEndsAt, null);

    h.clock.advance(365 * DAY);
    assert.equal((await pub('shawarma-corner')).status, 200, 'no expiry once approved');
    const login = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'fetch').send({ email: 'ahmad@corner.jo', password: 'Owner-Password-2026' });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.restaurant.trialEndsAt, null);

    await platform('post', `/restaurants/${restaurantId}/suspend`);
    assert.equal((await pub('shawarma-corner')).status, 403);
    await platform('post', `/restaurants/${restaurantId}/activate`);
    assert.equal((await platform('post', `/restaurants/${restaurantId}/extend-trial`, { days: 3 })).status, 409, 'nothing to extend once approved');
  });

  test('duplicate email or slug, weak password and bad input create nothing', async () => {
    const before = await h.models.Restaurant.countDocuments();
    const dupEmail = await signup(body({ slug: 'other-slug' }));
    assert.equal(dupEmail.status, 409);
    assert.equal(dupEmail.body.code, 'EMAIL_IN_USE');
    const dupSlug = await signup(body({ email: 'new@corner.jo' }));
    assert.equal(dupSlug.status, 409);
    assert.equal(dupSlug.body.code, 'SLUG_TAKEN');
    assert.equal((await signup(body({ email: 'x@y.jo', slug: 'x-y', password: 'short' }))).status, 400);
    assert.equal((await signup(body({ email: 'x@y.jo', slug: 'x-y', approved: true }))).status, 400, 'no mass assignment');
    assert.equal((await signup(body({ email: 'x@y.jo', slug: 'admin' }))).status, 400);
    assert.equal(await h.models.Restaurant.countDocuments(), before);
  });

  test('spam protections: honeypot and CSRF header', async () => {
    const before = await h.models.Restaurant.countDocuments();
    const bot = await signup(body({ email: 'bot@spam.jo', slug: 'bot-spam', website: 'http://spam' }));
    assert.equal(bot.status, 400);
    assert.equal(bot.body.code, 'SIGNUP_REJECTED');
    const noHeader = await request(h.app).post('/api/signup').send(body({ email: 'z@z.jo', slug: 'zz-z' }));
    assert.equal(noHeader.status, 403);
    assert.equal(await h.models.Restaurant.countDocuments(), before);
  });

  test('restaurants created by the Super Admin are approved and never expire', async () => {
    const res = await platform('post', '/restaurants', { name: 'Admin Made', slug: 'admin-made', owner: { name: 'O', email: 'o@admin-made.jo' } });
    assert.equal(res.body.data.restaurant.approved, true);
    assert.equal(res.body.data.restaurant.trialEndsAt, null);
    h.clock.advance(100 * DAY);
    assert.equal((await pub('admin-made')).status, 200);
  });
});

describe('Self sign-up disabled', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  before(async () => {
    h = await startHarness({ signupEnabled: false });
  });
  after(() => h?.stop());

  test('returns SIGNUP_DISABLED and creates nothing', async () => {
    const res = await request(h.app).post('/api/signup').set('X-Requested-With', 'fetch').send(body());
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'SIGNUP_DISABLED');
    assert.equal(await h.models.Restaurant.countDocuments(), 0);
  });
});
