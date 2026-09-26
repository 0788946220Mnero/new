import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { startHarness } from './harness.js';

const EMAIL = 'ninja@mero.com';
const INITIAL = 'Initial-Password-123';

describe('Super Admin with PLATFORM_MFA_REQUIRED=false', { skip: process.env.SKIP_DB_TESTS === '1' }, () => {
  let h;
  before(async () => {
    h = await startHarness({ mfaRequired: false });
    await h.seedSuperAdmin(EMAIL, INITIAL);
  });
  after(() => h?.stop());

  const login = (password) => request(h.app).post('/api/platform/auth/login').send({ email: EMAIL, password });

  test('email + password signs in directly, still forcing the password change', async () => {
    const res = await login(INITIAL);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.step, 'done');
    assert.ok(res.body.data.accessToken);
    assert.equal(res.body.data.mfaSecret, undefined);

    const blocked = await request(h.app).get('/api/platform/restaurants').set('Authorization', `Bearer ${res.body.data.accessToken}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');

    const changed = await request(h.app)
      .post('/api/platform/auth/change-password')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .send({ currentPassword: INITIAL, newPassword: 'Permanent-Password-99' });
    assert.equal(changed.status, 200);
    const ok = await request(h.app).get('/api/platform/restaurants').set('Authorization', `Bearer ${changed.body.data.accessToken}`);
    assert.equal(ok.status, 200);
  });

  test('wrong password and lockout still apply', async () => {
    assert.equal((await login('Wrong-Password-000')).status, 401);
    for (let i = 0; i < 5; i += 1) await login('Wrong-Password-000');
    assert.equal((await login('Permanent-Password-99')).status, 429);
    h.clock.advance(15 * 60 * 1000 + 1);
    assert.equal((await login('Permanent-Password-99')).body.data.step, 'done');
  });

  test('an account that enrolled MFA keeps being asked for the code', async () => {
    await h.models.PlatformUser.updateOne({ email: EMAIL }, { $set: { 'mfa.enabled': true, 'mfa.secretEncrypted': 'v1.x.y.z' } });
    const res = await login('Permanent-Password-99');
    assert.equal(res.body.data.step, 'mfa');
    assert.equal(res.body.data.accessToken, undefined);
  });
});
