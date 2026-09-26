import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { startHarness } from './harness.js';

const EMAIL = 'ninja@mero.com';
const INITIAL = 'Initial-Password-123';
const FINAL = 'Changed-Password-456!';

describe('Super Admin authentication', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  let mfaSecret;

  before(async () => {
    h = await startHarness();
    await h.seedSuperAdmin(EMAIL, INITIAL);
  });
  after(() => h?.stop());

  test('unknown email and wrong password look identical', async () => {
    const unknown = await request(h.app).post('/api/platform/auth/login').send({ email: 'x@y.com', password: INITIAL });
    const wrong = await request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password: 'nope-nope-nope' });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.message, wrong.body.message);
    assert.equal(unknown.body.code, 'INVALID_CREDENTIALS');
  });

  test('injection objects in login are rejected by validation', async () => {
    const res = await request(h.app).post('/api/platform/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 400);
  });

  test('first login forces MFA enrollment, then a password change', async () => {
    const login = await request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password: INITIAL });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.step, 'mfa-setup');
    assert.match(login.body.data.otpauthUrl, /^otpauth:\/\/totp\//);
    mfaSecret = login.body.data.mfaSecret;

    const bad = await request(h.app)
      .post('/api/platform/auth/mfa/setup')
      .send({ challengeToken: login.body.data.challengeToken, code: '000000' });
    assert.equal(bad.status, 401);

    const setup = await request(h.app)
      .post('/api/platform/auth/mfa/setup')
      .send({ challengeToken: login.body.data.challengeToken, code: h.code(mfaSecret) });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.data.mustChangePassword, true);
    const pendingToken = setup.body.data.accessToken;

    const blocked = await request(h.app).get('/api/platform/restaurants').set('Authorization', `Bearer ${pendingToken}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');

    const me = await request(h.app).get('/api/platform/auth/me').set('Authorization', `Bearer ${pendingToken}`);
    assert.equal(me.body.data.email, EMAIL);

    const weak = await request(h.app)
      .post('/api/platform/auth/change-password')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ currentPassword: INITIAL, newPassword: 'short' });
    assert.equal(weak.status, 400);

    const changed = await request(h.app)
      .post('/api/platform/auth/change-password')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ currentPassword: INITIAL, newPassword: FINAL });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.mustChangePassword, false);

    const oldToken = await request(h.app).get('/api/platform/auth/me').set('Authorization', `Bearer ${pendingToken}`);
    assert.equal(oldToken.status, 401, 'tokens issued before the password change must stop working');

    const ok = await request(h.app).get('/api/platform/restaurants').set('Authorization', `Bearer ${changed.body.data.accessToken}`);
    assert.equal(ok.status, 200);
  });

  test('MFA secret is stored encrypted, never in plain text', async () => {
    const raw = await h.models.PlatformUser.findOne({ email: EMAIL }).select('+mfa.secretEncrypted').lean();
    assert.equal(raw.mfa.enabled, true);
    assert.match(raw.mfa.secretEncrypted, /^v1\./);
    assert.ok(!raw.mfa.secretEncrypted.includes(mfaSecret));
  });

  test('later logins require a TOTP code, and a code cannot be reused', async () => {
    h.clock.advance(30_000);
    const first = await request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password: FINAL });
    assert.equal(first.body.data.step, 'mfa');
    assert.equal(first.body.data.mfaSecret, undefined);
    const code = h.code(mfaSecret);

    const ok = await request(h.app).post('/api/platform/auth/mfa/verify').send({ challengeToken: first.body.data.challengeToken, code });
    assert.equal(ok.status, 200);

    const second = await request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password: FINAL });
    const replay = await request(h.app).post('/api/platform/auth/mfa/verify').send({ challengeToken: second.body.data.challengeToken, code });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'INVALID_MFA_CODE');
  });

  test('challenge tokens and access tokens are not interchangeable', async () => {
    h.clock.advance(30_000);
    const login = await request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password: FINAL });
    const asAccess = await request(h.app).get('/api/platform/auth/me').set('Authorization', `Bearer ${login.body.data.challengeToken}`);
    assert.equal(asAccess.status, 401);

    const access = await h.login(EMAIL, FINAL, mfaSecret);
    const asChallenge = await request(h.app).post('/api/platform/auth/mfa/verify').send({ challengeToken: access, code: h.code(mfaSecret) });
    assert.equal(asChallenge.status, 401);
  });

  test('restaurant tokens are rejected on platform routes', async () => {
    const res = await request(h.app)
      .get('/api/platform/restaurants')
      .set('Authorization', `Bearer ${h.restaurantToken('rest_AAAAAAAA')}`);
    assert.equal(res.status, 401);
  });

  test('logout signs out every session', async () => {
    const a = await h.login(EMAIL, FINAL, mfaSecret);
    const b = await h.login(EMAIL, FINAL, mfaSecret);
    const out = await request(h.app).post('/api/platform/auth/logout').set('Authorization', `Bearer ${a}`);
    assert.equal(out.status, 200);
    for (const t of [a, b]) {
      assert.equal((await request(h.app).get('/api/platform/auth/me').set('Authorization', `Bearer ${t}`)).status, 401);
    }
  });

  test('account locks after 5 failed attempts, even with the right password', async () => {
    await h.seedSuperAdmin('ops@mero.com', INITIAL);
    for (let i = 0; i < 5; i += 1) {
      await request(h.app).post('/api/platform/auth/login').send({ email: 'ops@mero.com', password: 'wrong-password-x' });
    }
    const res = await request(h.app).post('/api/platform/auth/login').send({ email: 'ops@mero.com', password: INITIAL });
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'ACCOUNT_LOCKED');

    h.clock.advance(15 * 60 * 1000 + 1);
    const later = await request(h.app).post('/api/platform/auth/login').send({ email: 'ops@mero.com', password: INITIAL });
    assert.equal(later.status, 200);
  });

  test('login attempts are audited', async () => {
    const logs = await h.models.PlatformAuditLog.find({ action: { $in: ['platform.login', 'platform.login_failed', 'platform.mfa_enabled'] } }).lean();
    const actions = new Set(logs.map((l) => l.action));
    assert.ok(actions.has('platform.login'));
    assert.ok(actions.has('platform.login_failed'));
    assert.ok(actions.has('platform.mfa_enabled'));
  });
});
