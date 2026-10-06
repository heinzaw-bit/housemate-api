import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import {
  registerImmediateDispatch,
  shouldDispatch,
} from '../src/notification-dispatch.js';
import {
  createNotificationRunner,
  registerNotificationJob,
} from '../src/notification-job.js';
import { NotificationWorker, pushUrgency } from '../src/notification-worker.js';

const secret = 'test_scheduler_secret_with_32_characters';
test('successful record saves schedule after response; reads, failures, previews and test sends do not', async () => {
  const app = Fastify();
  const tasks: Promise<unknown>[] = [];
  let sends = 0;
  app.post('/v1/households/:id/announcements', async () => ({ saved: true }));
  registerImmediateDispatch(
    app,
    async () => {
      sends++;
    },
    (task) => tasks.push(task),
    async () => {},
  );
  const response = await app.inject({
    method: 'POST',
    url: '/v1/households/home/announcements',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.equal(sends, 1);
  await app.close();
  for (const [method, path, status] of [
    ['GET', '/v1/households/home/events', 200],
    ['POST', '/v1/households/home/events', 401],
    ['POST', '/v1/households/home/bills/edit-preview', 200],
    ['POST', '/v1/households/home/notifications/read-all', 204],
    ['POST', '/v1/households/home/push-subscriptions/device/test', 200],
  ])
    assert.equal(
      shouldDispatch(String(method), String(path), Number(status)),
      false,
    );
  assert.equal(
    shouldDispatch('POST', '/v1/households/home/shopping-items', 201),
    true,
  );
});
test('a save during an active pass requests one bounded follow-up; scheduled duplicate stays busy', async () => {
  let release = () => {};
  let calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = createNotificationRunner(async () => {
    calls++;
    if (calls === 1) await gate;
  });
  const first = runner.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runner.run(true), false);
  assert.equal(await runner.run(), false);
  release();
  await first;
  assert.equal(calls, 2);
});
test('worker drains more than one original batch and bounds small claims', async () => {
  let claims = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('WITH ready')) {
        claims++;
        return {
          rows:
            claims <= 7
              ? Array.from({ length: 4 }, (_, i) => ({
                  notification_id: `${claims}-${i}`,
                  subscription_id: 'device',
                  attempts: 1,
                  lease_id: 'lease',
                }))
              : [],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  await new NotificationWorker(pool, async () => {}, 'public').tick();
  assert.equal(claims, 8);
});
test('urgency applies to urgent announcements and imminent reminders only', () => {
  const now = Date.now();
  assert.equal(
    pushUrgency('urgent', 'created', new Date(now + 86400000), now),
    'high',
  );
  assert.equal(
    pushUrgency('important', 'created', new Date(now + 10000), now),
    'normal',
  );
  assert.equal(
    pushUrgency('normal', 'reminder', new Date(now + 300000), now),
    'high',
  );
  assert.equal(
    pushUrgency('normal', 'reminder', new Date(now + 86400000), now),
    'normal',
  );
});
test('read-only private health cannot invoke worker; degraded scheduled health reports and returns 503', async () => {
  let runs = 0,
    reports = 0;
  const app = Fastify();
  const health = {
    pending: 2,
    oldestDueSeconds: 181,
    recentFailures: 0,
    acceptedLast15Minutes: 0,
    maxCreationToAcceptanceSeconds: 0,
    maxQueueToAcceptanceSeconds: 0,
    healthy: false,
  };
  registerNotificationJob(
    app,
    secret,
    async () => {
      runs++;
      return true;
    },
    async () => {
      reports++;
    },
    async () => health,
  );
  assert.equal(
    (await app.inject('/internal/notifications/health')).statusCode,
    401,
  );
  const headers = { authorization: `Bearer ${secret}` };
  const result = await app.inject({
    url: '/internal/notifications/health',
    headers,
  });
  assert.equal(result.statusCode, 503);
  assert.equal(runs, 0);
  assert.deepEqual(result.json().delivery, health);
  const scheduled = await app.inject({
    url: '/internal/notifications/run',
    headers,
  });
  assert.equal(scheduled.statusCode, 503);
  assert.equal(runs, 1);
  assert.equal(reports, 1);
  await app.close();
});
