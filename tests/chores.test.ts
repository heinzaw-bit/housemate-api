import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import type { Chore, ChoreRepository } from '../src/chores.js';
import { ApiError } from '../src/errors.js';
import type { HouseholdRepository } from '../src/types.js';

test('chore routes authenticate, validate and preserve household boundaries', async () => {
  const householdId = '00000000-0000-4000-8000-000000000001';
  const foreignId = '00000000-0000-4000-8000-000000000002';
  const choreId = '00000000-0000-4000-8000-000000000003';
  const memberId = '00000000-0000-4000-8000-000000000004';
  const swapId = '00000000-0000-4000-8000-000000000005';
  const calls: string[] = [];
  const chore = { id: choreId, householdId } as Chore;
  const access = (household: string) => {
    if (household !== householdId)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const repo: ChoreRepository = {
    list: async (_, household) => {
      access(household);
      calls.push('list');
      return [chore];
    },
    get: async (_, household) => {
      access(household);
      calls.push('get');
      return chore;
    },
    create: async (_, household) => {
      access(household);
      calls.push('create');
      return chore;
    },
    reassign: async (_, household) => {
      access(household);
      calls.push('reassign');
      return chore;
    },
    complete: async (_, household) => {
      access(household);
      calls.push('complete');
      return chore;
    },
    skip: async (_, household) => {
      access(household);
      calls.push('skip');
      return chore;
    },
    requestSwap: async (_, household) => {
      access(household);
      calls.push('requestSwap');
      return chore;
    },
    respondSwap: async (_, household) => {
      access(household);
      calls.push('respondSwap');
      return chore;
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'user', email: null, displayName: 'User' }
        : null,
    households: {} as HouseholdRepository,
    chores: repo,
  });
  const headers = { authorization: 'Bearer valid' };
  const base = `/v1/households/${householdId}/chores`;
  const item = `${base}/${choreId}`;
  try {
    assert.equal((await app.inject(base)).statusCode, 401);
    assert.equal(
      (await app.inject({ url: `/v1/households/${foreignId}/chores`, headers }))
        .statusCode,
      404,
    );
    const list = await app.inject({ url: base, headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(list.json().chores[0].id, choreId);
    assert.equal((await app.inject({ url: item, headers })).statusCode, 200);
    const draft = {
      title: 'Clean kitchen',
      note: null,
      dueAtLocal: '2026-10-01T19:00',
      assigneeMemberId: memberId,
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: base, headers, payload: draft }))
        .statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: { ...draft, assigneeMemberId: 'invalid' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `${item}/assignment`,
          headers,
          payload: { assigneeMemberId: memberId, expectedRevision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/complete`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/skip`,
          headers,
          payload: { expectedRevision: 1, reason: 'Away' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/skip`,
          headers,
          payload: { expectedRevision: 1, reason: '' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/swap-requests`,
          headers,
          payload: { expectedRevision: 1, targetMemberId: memberId },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/swap-requests/${swapId}/response`,
          headers,
          payload: { expectedRevision: 2, decision: 'accepted' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${item}/swap-requests/${swapId}/response`,
          headers,
          payload: { expectedRevision: 2, decision: 'wrong' },
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(calls, [
      'list',
      'get',
      'create',
      'reassign',
      'complete',
      'skip',
      'requestSwap',
      'respondSwap',
    ]);
  } finally {
    await app.close();
  }
});
