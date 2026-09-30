import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { ApiError } from '../src/errors.js';
import {
  isQuietTime,
  privatePushPayload,
  pushErrorOutcome,
} from '../src/notification-worker.js';
import {
  defaultNotificationPreferences,
  type NotificationRepository,
  notificationHref,
  validateNotificationPreferences,
  validatePushRegistration,
} from '../src/notifications.js';
import type { HouseholdRepository } from '../src/types.js';

test('notification routes authenticate, preserve caller identity and validate read boundaries/preferences', async () => {
  const household = '00000000-0000-4000-8000-000000000001';
  const item = '00000000-0000-4000-8000-000000000002';
  const calls: unknown[] = [];
  const prefs = defaultNotificationPreferences('Asia/Bangkok');
  const access = (user: string, hh: string) => {
    assert.equal(user, 'verified');
    if (hh !== household)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const repo: NotificationRepository = {
    list: async (user, hh, scope, limit, cursor) => {
      access(user, hh);
      calls.push(['list', scope, limit, cursor]);
      return { notifications: [], unreadCount: 0, nextCursor: null };
    },
    markRead: async (user, hh, id) => {
      access(user, hh);
      calls.push(['read', id]);
    },
    markAllRead: async (user, hh, id) => {
      access(user, hh);
      calls.push(['all', id]);
    },
    preferences: async (user, hh) => {
      access(user, hh);
      return prefs;
    },
    savePreferences: async (user, hh, input) => {
      access(user, hh);
      validateNotificationPreferences(input);
      calls.push(['prefs']);
      return { ...input, timezone: 'Asia/Bangkok' };
    },
    devices: async (user) => {
      assert.equal(user, 'verified');
      return [];
    },
    subscribe: async (user, input) => {
      assert.equal(user, 'verified');
      calls.push(['subscribe', input.refreshOnly]);
      return {
        id: item,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastSentAt: null,
        lastError: null,
      };
    },
    unsubscribe: async (user, id) => {
      assert.equal(user, 'verified');
      calls.push(['unsubscribe', id]);
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'verified', email: null, displayName: 'Member' }
        : null,
    households: {} as HouseholdRepository,
    notifications: repo,
  });
  const headers = { authorization: 'Bearer valid' };
  const base = `/v1/households/${household}`;
  try {
    for (const url of [
      `${base}/notifications`,
      `${base}/notification-preferences`,
      '/v1/push-config',
      '/v1/push-subscriptions',
    ])
      assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${item}/notifications`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `${base}/notifications?limit=51`, headers }))
        .statusCode,
      400,
    );
    const page = await app.inject({
      url: `${base}/notifications?scope=unread&limit=10&cursor=opaque`,
      headers,
    });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/notifications/${item}/read`,
          headers,
          payload: { memberId: 'foreign' },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/notifications/read-all`,
          headers,
          payload: { throughId: item },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/notifications/read-all`,
          headers,
          payload: {},
        })
      ).statusCode,
      400,
    );
    const input = {
      categories: prefs.categories,
      quietHours: prefs.quietHours,
    };
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/notification-preferences`,
          headers,
          payload: input,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/notification-preferences`,
          headers,
          payload: {
            ...input,
            quietHours: { enabled: true, start: '23:00', end: '23:00' },
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/notification-preferences`,
          headers,
          payload: { ...input, categories: {} },
        })
      ).statusCode,
      400,
    );
    const config = await app.inject({ url: '/v1/push-config', headers });
    assert.deepEqual(config.json(), {
      enabled: false,
      publicKey: null,
      reason: 'server_setup',
    });
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/push-subscriptions/${item}`,
          headers,
        })
      ).statusCode,
      204,
    );
    assert.deepEqual(calls, [
      ['list', 'unread', 10, 'opaque'],
      ['read', item],
      ['all', item],
      ['prefs'],
      ['unsubscribe', item],
    ]);
  } finally {
    await app.close();
  }
});

test('push registration rejects arbitrary network destinations and malformed encryption keys', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  assert.doesNotThrow(() =>
    validatePushRegistration({
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys,
    }),
  );
  for (const endpoint of [
    'http://fcm.googleapis.com/a',
    'https://127.0.0.1/a',
    'https://example.com/a',
    'https://fcm.googleapis.com.attacker.example/a',
    'https://fcm.googleapis.com:8443/a',
    'https://user:pass@fcm.googleapis.com/a',
  ])
    assert.throws(() => validatePushRegistration({ endpoint, keys }), ApiError);
  assert.throws(
    () =>
      validatePushRegistration({
        endpoint: 'https://fcm.googleapis.com/a',
        keys: { ...keys, p256dh: 'bad' },
      }),
    ApiError,
  );
});

test('quiet windows, private push content and delivery retry policy cover day and overnight boundaries', () => {
  assert.equal(isQuietTime('23:00', '23:00', '07:00'), true);
  assert.equal(isQuietTime('06:59', '23:00', '07:00'), true);
  assert.equal(isQuietTime('07:00', '23:00', '07:00'), false);
  assert.equal(isQuietTime('15:00', '13:00', '16:00'), true);
  assert.equal(isQuietTime('16:00', '13:00', '16:00'), false);
  assert.equal(pushErrorOutcome(410, 1), 'invalid');
  assert.equal(pushErrorOutcome(403, 1), 'failed');
  assert.equal(pushErrorOutcome(429, 1), 'pending');
  assert.equal(pushErrorOutcome(503, 5), 'failed');
  const payload = JSON.parse(
    privatePushPayload('id', '/money?household=home&record=bill'),
  );
  assert.equal(payload.title, 'HouseMate');
  assert.equal(
    payload.body,
    'You have a household update. Open HouseMate to see it.',
  );
  const url = new URL(
    notificationHref('home', 'shopping', 'item'),
    'https://example.test',
  );
  assert.equal(url.pathname, '/house');
  assert.equal(url.searchParams.get('item'), 'item');
  assert.equal(
    new URL(
      notificationHref('home', 'poll', 'poll'),
      'https://example.test',
    ).searchParams.get('view'),
    'polls',
  );
});
