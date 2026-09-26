import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  databaseNameFor,
  generateRestaurantId,
  isValidDatabaseName,
  isValidRestaurantId,
  normalizeSlug,
} from '../src/tenants/tenantNaming.js';

describe('tenant naming', () => {
  test('generated ids are well-formed and unique', () => {
    const ids = new Set();
    for (let i = 0; i < 5000; i += 1) {
      const id = generateRestaurantId();
      assert.ok(isValidRestaurantId(id), id);
      assert.doesNotMatch(id.slice(5), /[01OI]/);
      ids.add(id);
    }
    assert.equal(ids.size, 5000);
  });

  test('database name is derived from restaurantId only', () => {
    assert.equal(databaseNameFor('rest_8F73K2QW'), 'restaurant_8F73K2QW');
    assert.throws(() => databaseNameFor('restaurant_registry'));
    assert.throws(() => databaseNameFor({ $ne: null }));
  });

  test('rejects dangerous database names', () => {
    for (const bad of ['restaurant_registry', 'admin', 'local', 'config', '../x', 'restaurant_aaaaaaaa', {}, null]) {
      assert.equal(isValidDatabaseName(bad), false, String(bad));
    }
    assert.equal(isValidDatabaseName('restaurant_ABCDEFGH'), true);
  });

  test('rejects non-string / operator ids', () => {
    for (const bad of [{ $gt: '' }, ['rest_AAAAAAAA'], 'rest_aaaaaaaa', 'rest_AAAA', 'rest_AAAAAAAA ', null, 42]) {
      assert.equal(isValidRestaurantId(bad), false, JSON.stringify(bad));
    }
  });

  test('normalizes and validates slugs', () => {
    assert.equal(normalizeSlug('  Diar-Alanbat '), 'diar-alanbat');
    for (const bad of ['admin', 'media', 'assets', 'api', 'a', '-abc', 'abc-', 'مطعم', 'a b c', 'x'.repeat(51), { $ne: 1 }, null]) {
      assert.equal(normalizeSlug(bad), null, JSON.stringify(bad));
    }
  });
});
