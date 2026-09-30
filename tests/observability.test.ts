import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { sanitizeErrorEvent } from '../src/error-reporting.js';
import { ApiError } from '../src/errors.js';
import type { HouseholdRepository } from '../src/types.js';

test('error reporting removes private payloads and source context', () => {
  const secret = 'PRIVATE_DATABASE_PASSWORD';
  const event = sanitizeErrorEvent({
    type: undefined,
    message: secret,
    user: { email: secret },
    request: { url: secret, headers: { Authorization: secret }, data: secret },
    breadcrumbs: [{ message: secret }],
    extra: { household: secret },
    contexts: {
      trace: {
        trace_id: '00000000000000000000000000000000',
        span_id: '0000000000000000',
        data: { token: secret },
      },
    },
    exception: {
      values: [
        {
          type: secret,
          value: secret,
          stacktrace: {
            frames: [
              {
                filename: `https://app.test/_next/static/chunks/main.js?token=${secret}`,
                lineno: 5,
                vars: { password: secret },
                pre_context: [secret],
              },
              { filename: `postgresql://user:${secret}@db.test/query.js` },
            ],
          },
        },
      ],
    },
    tags: { operation: 'api.notifications', household: secret },
  });
  assert.ok(!JSON.stringify(event).includes(secret));
  assert.equal(event.tags?.operation, 'api.notifications');
  assert.equal(
    event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.lineno,
    5,
  );
});

test('readiness reflects database failures without exposing their details; expected errors are not reported', async () => {
  const reports: string[] = [];
  let fail = false;
  const app = createApp({
    auth: async () => ({
      id: '00000000-0000-4000-8000-000000000001',
      email: null,
      displayName: 'Test',
    }),
    households: {
      getProfile: async () => {
        throw new ApiError(404, 'NOT_FOUND', 'Not found');
      },
    } as unknown as HouseholdRepository,
    readiness: async () => {
      if (fail) throw new Error('private database connection');
    },
    reportError: async (_error, operation) => {
      reports.push(operation);
    },
  });
  try {
    const ready = await app.inject('/health/ready');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.headers['cache-control'], 'no-store');
    fail = true;
    const unavailable = await app.inject('/health/ready');
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { status: 'unavailable' });
    await app.inject({
      url: '/v1/me',
      headers: { authorization: 'Bearer test' },
    });
    assert.deepEqual(reports, ['api.readiness']);
  } finally {
    await app.close();
  }
});
