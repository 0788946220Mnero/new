import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { startHarness } from './harness.js';

const ADMIN = 'ninja@mero.com';
const PW = 'Owner-Password-2026';

/** Extracts "fm_rt=<value>" from a response. */
function refreshCookie(res) {
  const raw = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('fm_rt='));
  return raw ? raw.split(';')[0] : null;
}
const tokenFromUrl = (url) => url.split('#token=')[1];

describe('Restaurant authentication, sessions and RBAC', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let admin;
  let A;
  let B;

  const auth = (path) => request(h.app).post(`/api/auth${path}`).set('X-Requested-With', 'fetch');
  const createRestaurant = async (slug, ownerEmail) => {
    const res = await request(h.app)
      .post('/api/platform/restaurants')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: `Rest ${slug}`, slug, owner: { name: 'Owner', email: ownerEmail } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { ...res.body.data.restaurant, setupToken: tokenFromUrl(res.body.data.owner.setupUrl), ownerEmail };
  };
  const setup = (token, password = PW) => auth('/setup-password').send({ token, password });
  const login = (email, password = PW) => auth('/login').send({ email, password });
  const bearer = (req, token) => req.set('Authorization', `Bearer ${token}`);

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(ADMIN, 'Initial-Password-123');
    ({ token: admin } = await h.enrollSuperAdmin(ADMIN, 'Initial-Password-123', 'Changed-Password-456!'));
    A = await createRestaurant('rest-a', 'owner@a.jo');
    B = await createRestaurant('rest-b', 'owner@b.jo');
  });
  after(() => h?.stop());

  // ------------------------------------------------------------- setup link
  test('owner sets a password from the setup link and is signed in', async () => {
    const weak = await setup(A.setupToken, 'short');
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, 'WEAK_PASSWORD');

    const res = await setup(A.setupToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.role, 'Owner');
    assert.ok(res.body.data.user.permissions.includes('users.manage'));
    assert.deepEqual(res.body.data.restaurant, { restaurantId: A.restaurantId, name: 'Rest rest-a', slug: 'rest-a', trialEndsAt: null });

    const cookie = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('fm_rt='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api\/auth/);
    assert.doesNotMatch(JSON.stringify(res.body), /fm_rt|refresh/i, 'refresh token must never be in the body');
  });

  test('a setup link works only once', async () => {
    const again = await setup(A.setupToken, 'Another-Password-2026');
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'INVALID_SETUP_TOKEN');
  });

  test('a setup link cannot be replayed against another restaurant', async () => {
    const secret = B.setupToken.split('.')[1];
    const forged = await setup(`${A.restaurantId}.${secret}`);
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'INVALID_SETUP_TOKEN');
    for (const bad of ['', 'garbage', `${B.restaurantId}.short`, 'rest_ZZZZZZZZ.' + 'x'.repeat(43)]) {
      assert.equal((await setup(bad)).status, 400);
    }
  });

  test('setup links expire after 72 hours', async () => {
    const C = await createRestaurant('rest-c', 'owner@c.jo');
    h.clock.advance(72 * 60 * 60 * 1000 + 1);
    const res = await setup(C.setupToken);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_SETUP_TOKEN');
    h.clock.advance(-(72 * 60 * 60 * 1000 + 1));
  });

  // ------------------------------------------------------------------ login
  test('login: unknown email, wrong password and invited users look identical', async () => {
    const unknown = await login('nobody@x.jo');
    const wrong = await login('owner@a.jo', 'Wrong-Password-000');
    const invited = await login('owner@b.jo'); // has not set a password yet
    for (const r of [unknown, wrong, invited]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'INVALID_CREDENTIALS');
    }
  });

  test('login resolves the right restaurant from the email alone', async () => {
    await setup(B.setupToken);
    const a = await login('OWNER@a.jo ');
    const b = await login('owner@b.jo');
    assert.equal(a.body.data.restaurant.restaurantId, A.restaurantId);
    assert.equal(b.body.data.restaurant.restaurantId, B.restaurantId);
  });

  test('requests without the X-Requested-With header are refused (CSRF)', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ email: 'owner@a.jo', password: PW });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CSRF_CHECK_FAILED');
  });

  // --------------------------------------------------------------- isolation
  test('each owner sees only their own restaurant users', async () => {
    const a = (await login('owner@a.jo')).body.data.accessToken;
    const b = (await login('owner@b.jo')).body.data.accessToken;
    const usersA = await bearer(request(h.app).get('/api/users'), a);
    const usersB = await bearer(request(h.app).get('/api/users'), b);
    assert.deepEqual(usersA.body.data.map((u) => u.email), ['owner@a.jo']);
    assert.deepEqual(usersB.body.data.map((u) => u.email), ['owner@b.jo']);

    const me = await bearer(request(h.app).get('/api/auth/me?restaurantId=' + B.restaurantId), a);
    assert.equal(me.body.data.restaurant.restaurantId, A.restaurantId);
  });

  test('forged, foreign and platform tokens are rejected', async () => {
    const forged = jwt.sign({ restaurantId: B.restaurantId, role: 'Owner' }, 'not-the-secret', {
      subject: 'x', audience: 'restaurant', issuer: 'free-menu',
    });
    assert.equal((await bearer(request(h.app).get('/api/users'), forged)).status, 401);
    assert.equal((await bearer(request(h.app).get('/api/users'), admin)).status, 401, 'Super Admin token must not work on restaurant routes');

    // A validly-signed token naming restaurant B but a user from A must fail (user not in B's database).
    const a = (await login('owner@a.jo')).body.data;
    const crossed = jwt.sign({ restaurantId: B.restaurantId, role: 'Owner', sid: 'x', ver: 1 }, h.restaurantSecret, {
      subject: a.user.id, audience: 'restaurant', issuer: 'free-menu', expiresIn: 600,
    });
    assert.equal((await bearer(request(h.app).get('/api/users'), crossed)).status, 401);
  });

  // ---------------------------------------------------------------- refresh
  test('refresh rotates the cookie; replaying an old cookie revokes the session', async () => {
    const res = await login('owner@a.jo');
    const c1 = refreshCookie(res);

    const r1 = await auth('/refresh').set('Cookie', c1);
    assert.equal(r1.status, 200);
    const c2 = refreshCookie(r1);
    assert.ok(c2 && c2 !== c1);
    assert.ok(r1.body.data.accessToken);

    // Two tabs refreshing together: the late one (old cookie) is accepted within the grace window.
    const concurrent = await auth('/refresh').set('Cookie', c1);
    assert.equal(concurrent.status, 200);
    assert.equal(refreshCookie(concurrent), null, 'grace response must not issue a new cookie');

    // Much later, the old cookie shows up again: theft. The whole session dies.
    h.clock.advance(60_000);
    const replay = await auth('/refresh').set('Cookie', c1);
    assert.equal(replay.status, 401);
    const legit = await auth('/refresh').set('Cookie', c2);
    assert.equal(legit.status, 401, 'the current cookie is revoked too');

    const tenantLogs = await h.tenantDb(A.databaseName).db.collection('auditLogs').findOne({ action: 'session.reuse_detected' });
    assert.ok(tenantLogs);
  });

  test('refresh without a cookie or with garbage fails and clears the cookie', async () => {
    assert.equal((await auth('/refresh')).status, 401);
    const bad = await auth('/refresh').set('Cookie', 'fm_rt=abc.def');
    assert.equal(bad.status, 401);
    assert.match([].concat(bad.headers['set-cookie']).join(';'), /fm_rt=;/);
  });

  test('sessions expire after 30 days without use', async () => {
    const c = refreshCookie(await login('owner@a.jo'));
    h.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    assert.equal((await auth('/refresh').set('Cookie', c)).status, 401);
    assert.ok((await h.sessions.purgeExpired()) >= 1);
    h.clock.advance(-(30 * 24 * 60 * 60 * 1000 + 1));
  });

  test('logout revokes the refresh session', async () => {
    const c = refreshCookie(await login('owner@a.jo'));
    const out = await auth('/logout').set('Cookie', c);
    assert.equal(out.status, 200);
    assert.equal((await auth('/refresh').set('Cookie', c)).status, 401);
  });

  test('changing the password signs out other devices and old access tokens', async () => {
    const other = await login('owner@a.jo');
    const otherCookie = refreshCookie(other);
    const oldAccess = other.body.data.accessToken;

    const mine = await login('owner@a.jo');
    const changed = await bearer(auth('/change-password'), mine.body.data.accessToken)
      .send({ currentPassword: PW, newPassword: 'New-Owner-Password-99' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.ok(refreshCookie(changed));

    assert.equal((await auth('/refresh').set('Cookie', otherCookie)).status, 401);
    assert.equal((await bearer(request(h.app).get('/api/auth/me'), oldAccess)).status, 401);
    assert.equal((await bearer(request(h.app).get('/api/auth/me'), changed.body.data.accessToken)).status, 200);

    // restore for later tests
    await bearer(auth('/change-password'), changed.body.data.accessToken).send({ currentPassword: 'New-Owner-Password-99', newPassword: PW });
  });

  test('account locks after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i += 1) await login('owner@b.jo', 'Wrong-Password-000');
    const res = await login('owner@b.jo');
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'ACCOUNT_LOCKED');
    h.clock.advance(15 * 60 * 1000 + 1);
    assert.equal((await login('owner@b.jo')).status, 200);
  });

  // ------------------------------------------------------------- employees
  test('owner invites an employee who can manage the menu but not users', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const invite = await bearer(request(h.app).post('/api/users'), owner).send({ name: 'Cashier', email: 'staff@a.jo' });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    assert.equal(invite.body.data.user.role, 'Editor');
    assert.ok(!invite.body.data.user.permissions.includes('users.manage'));

    const done = await setup(tokenFromUrl(invite.body.data.setup.setupUrl), 'Staff-Password-2026');
    assert.equal(done.status, 200);
    const staff = done.body.data.accessToken;
    assert.ok(done.body.data.user.permissions.includes('products.create'));

    const denied = await bearer(request(h.app).get('/api/users'), staff);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'FORBIDDEN');
  });

  test('employees can never be granted users.manage', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const res = await bearer(request(h.app).post('/api/users'), owner)
      .send({ name: 'X', email: 'x@a.jo', permissions: ['users.manage'] });
    assert.equal(res.status, 400);
    const withRole = await bearer(request(h.app).post('/api/users'), owner).send({ name: 'X', email: 'x@a.jo', role: 'Owner' });
    assert.equal(withRole.status, 400, 'role is not an accepted field');
  });

  test('an email used anywhere on the platform cannot be invited again', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const res = await bearer(request(h.app).post('/api/users'), owner).send({ name: 'X', email: 'owner@b.jo' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'EMAIL_IN_USE');
  });

  test('disabling an employee cuts access immediately', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const staffLogin = await login('staff@a.jo', 'Staff-Password-2026');
    const staffToken = staffLogin.body.data.accessToken;
    const staffCookie = refreshCookie(staffLogin);
    const staffId = staffLogin.body.data.user.id;

    const off = await bearer(request(h.app).patch(`/api/users/${staffId}`), owner).send({ status: 'disabled' });
    assert.equal(off.body.data.status, 'disabled');
    assert.equal((await bearer(request(h.app).get('/api/auth/me'), staffToken)).status, 401);
    assert.equal((await auth('/refresh').set('Cookie', staffCookie)).status, 401);
    assert.equal((await login('staff@a.jo', 'Staff-Password-2026')).status, 401);

    const on = await bearer(request(h.app).patch(`/api/users/${staffId}`), owner).send({ status: 'active' });
    assert.equal(on.body.data.status, 'active');
    assert.equal((await login('staff@a.jo', 'Staff-Password-2026')).status, 200);
  });

  test('permission changes apply on the next request', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const staff = (await login('staff@a.jo', 'Staff-Password-2026')).body.data;
    await bearer(request(h.app).patch(`/api/users/${staff.user.id}`), owner).send({ permissions: ['menu.view'] });
    const me = await bearer(request(h.app).get('/api/auth/me'), staff.accessToken);
    assert.deepEqual(me.body.data.user.permissions, ['menu.view']);
  });

  test('the owner account is protected; other restaurants users are invisible', async () => {
    const ownerA = (await login('owner@a.jo')).body.data;
    const ownerB = (await login('owner@b.jo')).body.data;
    const self = await bearer(request(h.app).patch(`/api/users/${ownerA.user.id}`), ownerA.accessToken).send({ status: 'disabled' });
    assert.equal(self.status, 403);
    assert.equal(self.body.code, 'OWNER_PROTECTED');

    const staffA = (await login('staff@a.jo', 'Staff-Password-2026')).body.data.user.id;
    for (const [method, path] of [['patch', `/api/users/${staffA}`], ['delete', `/api/users/${staffA}`], ['post', `/api/users/${staffA}/reset-access`]]) {
      const res = await bearer(request(h.app)[method](path), ownerB.accessToken).send(method === 'patch' ? { name: 'hacked' } : undefined);
      assert.equal(res.status, 404, `${method} ${path} from restaurant B must not find A's user`);
    }
    assert.equal((await bearer(request(h.app).patch('/api/users/not-an-id'), ownerA.accessToken).send({ name: 'x' })).status, 404);
  });

  test('reset access and delete an employee', async () => {
    const owner = (await login('owner@a.jo')).body.data.accessToken;
    const staffId = (await login('staff@a.jo', 'Staff-Password-2026')).body.data.user.id;

    const reset = await bearer(request(h.app).post(`/api/users/${staffId}/reset-access`), owner);
    assert.equal(reset.status, 200);
    assert.equal((await login('staff@a.jo', 'Staff-Password-2026')).status, 401, 'old password stops working');

    const del = await bearer(request(h.app).delete(`/api/users/${staffId}`), owner);
    assert.equal(del.status, 200);
    assert.equal(await h.models.UserDirectory.countDocuments({ email: 'staff@a.jo' }), 0);
    const again = await bearer(request(h.app).post('/api/users'), owner).send({ name: 'Back', email: 'staff@a.jo' });
    assert.equal(again.status, 201, 'email is free again after deletion');
  });

  // ------------------------------------------------- platform interactions
  test('suspending a restaurant ends all its sessions; login explains why', async () => {
    const res = await login('owner@b.jo');
    const cookie = refreshCookie(res);
    const access = res.body.data.accessToken;

    await request(h.app).post(`/api/platform/restaurants/${B.restaurantId}/suspend`).set('Authorization', `Bearer ${admin}`);
    assert.equal((await bearer(request(h.app).get('/api/auth/me'), access)).status, 403);
    assert.equal((await auth('/refresh').set('Cookie', cookie)).status, 401);
    const blocked = await login('owner@b.jo');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'TENANT_UNAVAILABLE');

    await request(h.app).post(`/api/platform/restaurants/${B.restaurantId}/activate`).set('Authorization', `Bearer ${admin}`);
    assert.equal((await login('owner@b.jo')).status, 200);
  });

  test('Super Admin "reset owner access" signs the owner out everywhere', async () => {
    const res = await login('owner@b.jo');
    const cookie = refreshCookie(res);
    const reset = await request(h.app).post(`/api/platform/restaurants/${B.restaurantId}/reset-owner-access`).set('Authorization', `Bearer ${admin}`);
    assert.equal(reset.status, 200);
    assert.equal((await auth('/refresh').set('Cookie', cookie)).status, 401);
    assert.equal((await login('owner@b.jo')).status, 401);
    assert.equal((await setup(tokenFromUrl(reset.body.data.setupUrl))).status, 200);
  });
});
