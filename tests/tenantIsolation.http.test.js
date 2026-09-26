import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { stripTenantOverrides, tenantFromAuth, tenantFromSlug } from '../src/middleware/tenant.js';
import { A, B, closeAll, setupManager, silentLogger } from './helpers.js';

after(closeAll);

// Stand-in for the Phase 4 auth middleware: the test sets the "verified" token claims.
function fakeAuth(req, _res, next) {
  const raw = req.get('x-test-auth');
  if (raw) req.auth = JSON.parse(raw);
  next();
}

function buildApp() {
  const { manager } = setupManager();
  const app = express();
  app.use(express.json());
  app.use(stripTenantOverrides);
  app.use(fakeAuth);
  app.all('/api/me', tenantFromAuth(manager), (req, res) => {
    res.json({ restaurantId: req.tenant.restaurantId, db: req.tenant.databaseName, body: req.body, query: req.query });
  });
  app.get('/public/:slug', tenantFromSlug(manager), (req, res) => {
    res.json({ restaurantId: req.tenant.restaurantId });
  });
  app.use(errorHandler(silentLogger));
  return app;
}

const asA = JSON.stringify({ sub: 'u1', restaurantId: A, role: 'Owner', aud: 'restaurant' });

describe('HTTP tenant isolation', () => {
  test('tenant comes from the token only', async () => {
    const res = await request(buildApp()).get('/api/me').set('x-test-auth', asA);
    assert.equal(res.status, 200);
    assert.equal(res.body.db, 'restaurant_AAAAAAAA');
  });

  test('restaurantId / databaseName in query are ignored and stripped', async () => {
    const res = await request(buildApp())
      .get(`/api/me?restaurantId=${B}&databaseName=restaurant_BBBBBBBB&clusterId=eu2`)
      .set('x-test-auth', asA);
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurantId, A);
    assert.deepEqual(res.body.query, {});
  });

  test('restaurantId / databaseName in body are ignored and stripped', async () => {
    const res = await request(buildApp())
      .post('/api/me')
      .set('x-test-auth', asA)
      .send({ restaurantId: B, databaseName: 'restaurant_BBBBBBBB', name: 'x' });
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurantId, A);
    assert.deepEqual(res.body.body, { name: 'x' });
  });

  test('no token -> 401 with clean JSON', async () => {
    const res = await request(buildApp()).get('/api/me');
    assert.equal(res.status, 401);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'success']);
    assert.equal(res.body.success, false);
  });

  test('platform (Super Admin) token is rejected on restaurant routes', async () => {
    const res = await request(buildApp())
      .get('/api/me')
      .set('x-test-auth', JSON.stringify({ sub: 'sa', restaurantId: A, aud: 'platform' }));
    assert.equal(res.status, 401);
  });

  test('token for an unknown restaurant -> 404, no data', async () => {
    const res = await request(buildApp())
      .get('/api/me')
      .set('x-test-auth', JSON.stringify({ sub: 'u', restaurantId: 'rest_ZZZZZZZZ', aud: 'restaurant' }));
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'TENANT_NOT_FOUND');
  });

  test('public slug resolves only its own restaurant', async () => {
    const app = buildApp();
    assert.equal((await request(app).get('/public/alpha')).body.restaurantId, A);
    assert.equal((await request(app).get('/public/beta')).body.restaurantId, B);
    assert.equal((await request(app).get('/public/admin')).status, 404);
    assert.equal((await request(app).get('/public/restaurant_registry')).status, 404);
  });
});
