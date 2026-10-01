import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { createApp } from '../src/application.js';
import type { ChoreRepository } from '../src/chores.js';
import { priorCreate } from '../src/create-request.js';
import { ApiError } from '../src/errors.js';
import type { ShoppingRepository } from '../src/shopping.js';
import type { HouseholdRepository } from '../src/types.js';

const key = '00000000-0000-4000-8000-000000000001';
test('creation retries bind household, creator and original payload and reject key reuse', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  let row: { id: string; request_hash: string } | undefined;
  const client = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: sql.startsWith('SELECT id,') && row ? [row] : [] };
    },
  } as unknown as PoolClient;
  assert.deepEqual(
    await priorCreate(client, 'chores', 'house', 'caller', undefined, {
      title: 'Dishes',
    }),
    { id: null, hash: null },
  );
  assert.equal(queries.length, 0);
  const first = await priorCreate(client, 'chores', 'house', 'caller', key, {
    title: 'Dishes',
  });
  assert.ok(first.hash);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(queries[0]?.params, [`chores:house:caller:${key}`]);
  assert.deepEqual(queries[1]?.params, ['house', 'caller', key]);
  row = { id: 'saved', request_hash: first.hash };
  assert.equal(
    (
      await priorCreate(client, 'chores', 'house', 'caller', key, {
        title: 'Dishes',
      })
    ).id,
    'saved',
  );
  await assert.rejects(
    priorCreate(client, 'chores', 'house', 'caller', key, { title: 'Changed' }),
    (cause: unknown) =>
      cause instanceof ApiError && cause.code === 'IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    priorCreate(client, 'chores', 'house', 'caller', 'invalid', {}),
    ApiError,
  );
});

test('normal shopping and chore routes accept optional confirmation keys and pass verified identity', async () => {
  const captured: unknown[][] = [];
  const create = async (...args: unknown[]) => {
    captured.push(args);
    return { id: 'saved' };
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'verified', email: null, displayName: 'Verified' }
        : null,
    households: {} as HouseholdRepository,
    shopping: { create } as unknown as ShoppingRepository,
    chores: { create } as unknown as ChoreRepository,
  });
  const home = '00000000-0000-4000-8000-000000000002';
  const member = '00000000-0000-4000-8000-000000000003';
  const headers = { authorization: 'Bearer valid' };
  try {
    for (const [path, draft] of [
      [
        'shopping-items',
        {
          title: 'Eggs',
          quantity: null,
          unit: null,
          note: null,
          priority: 'normal',
          assignedBuyerMemberId: null,
          estimatedPriceMinor: null,
        },
      ],
      [
        'chores',
        {
          title: 'Kitchen',
          note: null,
          dueAtLocal: '2099-01-01T12:00',
          assigneeMemberId: member,
        },
      ],
    ] as const) {
      const url = `/v1/households/${home}/${path}`;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { ...draft, idempotencyKey: key },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...draft, idempotencyKey: 'invalid' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...draft, idempotencyKey: key },
          })
        ).statusCode,
        201,
      );
      assert.deepEqual(captured.at(-1)?.slice(0, 2), ['verified', home]);
      assert.equal(captured.at(-1)?.[3], key);
      assert.equal(
        (await app.inject({ method: 'POST', url, headers, payload: draft }))
          .statusCode,
        201,
      );
      assert.equal(captured.at(-1)?.[3], undefined);
    }
    assert.equal(captured.length, 4);
  } finally {
    await app.close();
  }
});
