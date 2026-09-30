import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import type { Dashboard } from '../src/dashboard.js';
import { ApiError } from '../src/errors.js';
import type { HouseholdRepository } from '../src/types.js';

test('dashboard requires authentication, validates IDs, scopes access, and is never cached', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const foreign = '00000000-0000-4000-8000-000000000002';
  const calls: string[] = [];
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: 'user', email: null, displayName: 'Member' }
        : null,
    households: {} as HouseholdRepository,
    dashboard: {
      get: async (user, household) => {
        calls.push(`${user}:${household}`);
        if (household !== id)
          throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
        return {
          householdId: household,
          recentActivity: [],
        } as unknown as Dashboard;
      },
    },
  });
  const headers = { authorization: 'Bearer member' };
  try {
    assert.equal(
      (await app.inject(`/v1/households/${id}/dashboard`)).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/v1/households/invalid/dashboard', headers }))
        .statusCode,
      400,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${foreign}/dashboard`,
          headers,
        })
      ).statusCode,
      404,
    );
    const result = await app.inject({
      url: `/v1/households/${id}/dashboard`,
      headers,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.json().householdId, id);
    assert.deepEqual(calls, [`user:${foreign}`, `user:${id}`]);
  } finally {
    await app.close();
  }
});
