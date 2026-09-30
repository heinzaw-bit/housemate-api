import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { ApiError } from '../src/errors.js';
import type { EventRepository, HouseholdEvent } from '../src/events.js';
import type { HouseholdRepository } from '../src/types.js';

test('event routes authenticate, validate input, and pass attendance through the household scope', async () => {
  const householdId = '00000000-0000-4000-8000-000000000001';
  const foreignId = '00000000-0000-4000-8000-000000000002';
  const eventId = '00000000-0000-4000-8000-000000000003';
  const calls: string[] = [];
  const event = {
    id: eventId,
    householdId,
    attendees: [],
    counts: { going: 0, maybe: 0, notGoing: 0, awaiting: 0 },
  } as unknown as HouseholdEvent;
  const access = (id: string) => {
    if (id !== householdId)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const repo: EventRepository = {
    list: async (_, id, scope, limit, offset) => {
      access(id);
      calls.push(`list:${scope}:${limit}:${offset}`);
      return [event];
    },
    get: async (_, id, requestedId) => {
      access(id);
      return requestedId === eventId ? event : null;
    },
    create: async (_, id, draft) => {
      access(id);
      calls.push(`create:${draft.title}`);
      return event;
    },
    respond: async (_, id, requestedId, response) => {
      access(id);
      calls.push(`respond:${requestedId}:${response}`);
      return event;
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'user', email: null, displayName: 'User' }
        : null,
    households: {} as HouseholdRepository,
    events: repo,
  });
  const headers = { authorization: 'Bearer valid' };
  const base = `/v1/households/${householdId}/events`;
  try {
    assert.equal((await app.inject(base)).statusCode, 401);
    assert.equal(
      (await app.inject({ url: `/v1/households/${foreignId}/events`, headers }))
        .statusCode,
      404,
    );
    const list = await app.inject({
      url: `${base}?scope=past&limit=10&offset=5`,
      headers,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(list.json().events[0].id, eventId);
    assert.equal(
      (await app.inject({ url: `${base}?scope=invalid`, headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `${base}/invalid`, headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `${base}/${eventId}`, headers })).statusCode,
      200,
    );
    const draft = {
      title: 'Dinner',
      startsAtLocal: '2026-10-01T19:00',
      idempotencyKey: '00000000-0000-4000-8000-000000000004',
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
          payload: { ...draft, startsAtLocal: 'bad' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${eventId}/attendance`,
          headers,
          payload: { response: 'going' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${eventId}/attendance`,
          headers,
          payload: { response: 'invalid' },
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(calls, [
      'list:past:10:5',
      'create:Dinner',
      `respond:${eventId}:going`,
    ]);
  } finally {
    await app.close();
  }
});
