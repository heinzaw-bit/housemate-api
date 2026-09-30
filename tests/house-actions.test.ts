import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { ApiError } from '../src/errors.js';
import type { HouseActions } from '../src/house-actions.js';
import type { HouseholdRepository } from '../src/types.js';

test('house actions require authentication and active household access', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const foreign = '00000000-0000-4000-8000-000000000002';
  const calls: string[] = [];
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: 'user', email: null, displayName: 'Member' }
        : null,
    households: {} as HouseholdRepository,
    houseActions: {
      get: async (user, household) => {
        calls.push(`${user}:${household}`);
        if (household !== id)
          throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
        return {
          householdId: household,
          generatedAt: new Date().toISOString(),
          mealResponses: [],
          swapRequests: [],
          chores: [],
          shopping: [],
          announcements: [],
          polls: [],
        } satisfies HouseActions;
      },
    },
  });
  const headers = { authorization: 'Bearer member' };
  try {
    assert.equal(
      (await app.inject(`/v1/households/${id}/house-actions`)).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: '/v1/households/invalid/house-actions',
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${foreign}/house-actions`,
          headers,
        })
      ).statusCode,
      404,
    );
    const result = await app.inject({
      url: `/v1/households/${id}/house-actions`,
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
