import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { ApiError } from '../src/errors.js';
import type { Meal, MealRepository } from '../src/meals.js';
import type { HouseholdRepository } from '../src/types.js';

test('meal routes authenticate, validate bodies, scope household access, and return fresh data', async () => {
  const householdId = '00000000-0000-4000-8000-000000000001';
  const foreignId = '00000000-0000-4000-8000-000000000002';
  const mealId = '00000000-0000-4000-8000-000000000003';
  const memberId = '00000000-0000-4000-8000-000000000004';
  const key = '00000000-0000-4000-8000-000000000005';
  const calls: string[] = [];
  const meal = {
    id: mealId,
    householdId,
    counts: { joining: 0, notJoining: 0, maybe: 0, awaiting: 1 },
  } as Meal;
  const access = (household: string) => {
    if (household !== householdId)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const repo: MealRepository = {
    list: async (_, household, scope, limit, offset) => {
      access(household);
      calls.push(`list:${scope}:${limit}:${offset}`);
      return [meal];
    },
    get: async (_, household, id) => {
      access(household);
      calls.push('get');
      return id === mealId ? meal : null;
    },
    create: async (_, household) => {
      access(household);
      calls.push('create');
      return meal;
    },
    respond: async (_, household, _id, response) => {
      access(household);
      calls.push(`answer:${response}`);
      return meal;
    },
    setRoles: async (_, household, _id, roles) => {
      access(household);
      calls.push(`roles:${roles.length}`);
      return meal;
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'user', email: null, displayName: 'User' }
        : null,
    households: {} as HouseholdRepository,
    meals: repo,
  });
  const headers = { authorization: 'Bearer valid' };
  try {
    assert.equal(
      (await app.inject(`/v1/households/${householdId}/meals`)).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: `/v1/households/${foreignId}/meals`, headers }))
        .statusCode,
      404,
    );
    const list = await app.inject({
      url: `/v1/households/${householdId}/meals`,
      headers,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(list.json().meals[0].id, mealId);
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${householdId}/meals?scope=reply&limit=10&offset=5`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${householdId}/meals?scope=invalid`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${householdId}/meals/invalid`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${householdId}/meals/${mealId}`,
          headers,
        })
      ).statusCode,
      200,
    );
    const draft = {
      mealType: 'dinner',
      question: 'Joining?',
      startsAtLocal: '2026-10-01T19:00',
      responseDeadlineLocal: '2026-10-01T18:00',
      participantIds: [memberId],
      cookingRoles: [],
      idempotencyKey: key,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/households/${householdId}/meals`,
          headers,
          payload: draft,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/households/${householdId}/meals`,
          headers,
          payload: { ...draft, mealType: 'invalid' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/households/${householdId}/meals/${mealId}/response`,
          headers,
          payload: { response: 'joining' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/households/${householdId}/meals/${mealId}/response`,
          headers,
          payload: { response: 'wrong' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/households/${householdId}/meals/${mealId}/cooking-roles`,
          headers,
          payload: { cookingRoles: [{ memberId, role: 'Cook' }] },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(calls, [
      'list:all:50:0',
      'list:reply:10:5',
      'get',
      'create',
      'answer:joining',
      'roles:1',
    ]);
  } finally {
    await app.close();
  }
});
