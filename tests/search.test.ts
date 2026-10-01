import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/application.js';
import { ApiError } from '../src/errors.js';
import {
  decodeSearchCursor,
  normalizeSearch,
  PgSearchRepository,
  type SearchRepository,
  searchPattern,
} from '../src/search.js';
import type { HouseholdRepository } from '../src/types.js';

const household = '00000000-0000-4000-8000-000000000001';
const record = '00000000-0000-4000-8000-000000000002';
test('search validates literal input and scopes microsecond cursors', () => {
  assert.equal(searchPattern('50%_!\\'), '%50!%!_!!\\%');
  assert.deepEqual(normalizeSearch({ q: '  Rent  ' }), {
    q: 'Rent',
    type: 'all',
    limit: 20,
  });
  for (const q of [' ', 'a', 'x'.repeat(121), 'ab\0'])
    assert.throws(() => normalizeSearch({ q }), ApiError);
  for (const limit of [0, 51, 1.5])
    assert.throws(() => normalizeSearch({ q: 'rent', limit }), ApiError);
  const cursor = {
    scope: 'scope',
    date: '2026-10-01T00:00:00.123456Z',
    type: 'bill',
    id: record,
  };
  const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  assert.equal(decodeSearchCursor(encoded, 'scope').date, cursor.date);
  assert.throws(() => decodeSearchCursor(encoded, 'other'), ApiError);
  for (const value of [
    '?',
    'A'.repeat(1025),
    Buffer.from(
      JSON.stringify({ ...cursor, date: '2026-02-30T00:00:00.123456Z' }),
    ).toString('base64url'),
  ])
    assert.throws(() => decodeSearchCursor(value, 'scope'), ApiError);
});

test('search route authenticates, validates and passes only the verified caller; pages are no-store', async () => {
  let calls = 0;
  const repository: SearchRepository = {
    search: async (user, id, input) => {
      calls++;
      assert.equal(user, 'verified');
      if (id !== household)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      assert.equal(input.q, 'rent');
      assert.equal(input.type, 'bill');
      assert.equal(input.limit, 10);
      return { results: [], nextCursor: null };
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'verified', email: null, displayName: 'Verified' }
        : null,
    households: {} as HouseholdRepository,
    search: repository,
  });
  const headers = { authorization: 'Bearer valid' };
  try {
    assert.equal(
      (await app.inject(`/v1/households/${household}/search?q=rent`))
        .statusCode,
      401,
    );
    assert.equal(calls, 0);
    for (const query of [
      '',
      '?q=a',
      '?q=%20%20',
      '?q=rent&type=unknown',
      '?q=rent&limit=51',
      '?q=ab%00',
    ])
      assert.equal(
        (
          await app.inject({
            url: `/v1/households/${household}/search${query}`,
            headers,
          })
        ).statusCode,
        400,
      );
    const response = await app.inject({
      url: `/v1/households/${household}/search?q=rent&type=bill&limit=10`,
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${record}/search?q=rent&type=bill&limit=10`,
          headers,
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test('database membership failure occurs before record search and rolls back/releases', async () => {
  const statements: string[] = [];
  let released = false;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as Pool;
  await assert.rejects(
    new PgSearchRepository(pool).search('caller', household, { q: 'rent' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 404,
  );
  assert.equal(
    statements.some((sql) => sql.includes('WITH viewer')),
    false,
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('bounded search timeouts return a safe retryable service error', async () => {
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes('SELECT m.id AS member_id'))
          return {
            rows: [
              {
                member_id: record,
                user_id: household,
                timezone: 'UTC',
                role: 'member',
              },
            ],
          };
        if (sql.includes('WITH viewer'))
          throw Object.assign(new Error('private query'), { code: '57014' });
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  await assert.rejects(
    new PgSearchRepository(pool).search('caller', household, { q: 'rent' }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.statusCode === 503 &&
      error.code === 'SEARCH_TIMEOUT' &&
      !error.message.includes('private'),
  );
});
