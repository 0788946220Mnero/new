import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { silentLogger } from './helpers.js';

function build({ pingFails = false } = {}) {
  return createApp({
    config: { TRUST_PROXY: 1, CORS_ORIGINS: ['https://menu.example.com'] },
    logger: silentLogger,
    clusters: {
      async ping() {
        if (pingFails) throw new Error('mongodb+srv://user:SECRET@host unreachable');
      },
    },
  });
}

describe('app', () => {
  test('health and readiness', async () => {
    const ok = await request(build()).get('/health');
    assert.equal(ok.status, 200);
    assert.ok(ok.headers['x-request-id']);
    assert.equal((await request(build()).get('/health/ready')).status, 200);

    const down = await request(build({ pingFails: true })).get('/health/ready');
    assert.equal(down.status, 503);
    assert.doesNotMatch(JSON.stringify(down.body), /SECRET|mongodb/);
  });

  test('security headers on, x-powered-by off', async () => {
    const res = await request(build()).get('/health');
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.ok(res.headers['x-content-type-options']);
    assert.ok(res.headers['content-security-policy']);
  });

  test('CORS allows only configured origins', async () => {
    const good = await request(build()).get('/health').set('Origin', 'https://menu.example.com');
    assert.equal(good.headers['access-control-allow-origin'], 'https://menu.example.com');
    const bad = await request(build()).get('/health').set('Origin', 'https://evil.example');
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });

  test('unknown route and bad JSON return clean errors without stack traces', async () => {
    const nf = await request(build()).get('/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.success, false);

    const bad = await request(build())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(bad.body), /at \w+ \(|node_modules/);
  });
});
