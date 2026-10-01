import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { databasePoolOptions } from '../src/database.js';
import {
  createNotificationRunner,
  registerNotificationJob,
} from '../src/notification-job.js';
import { createRuntime } from '../src/runtime.js';

const secret = 'test_scheduler_secret_with_32_characters';
const env = {
  DATABASE_URL: 'postgresql://test:password@localhost:5432/test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test_publishable_key',
};
const vercelEnv = {
  ...env,
  VERCEL: '1',
  CRON_SECRET: secret,
  WEB_ORIGINS: 'https://example.test',
};

test('Vercel startup requires a job secret and explicit web origins; local config remains usable', () => {
  assert.equal(loadConfig(env).serverless, false);
  assert.equal(loadConfig(env).cronSecret, null);
  assert.throws(() => loadConfig({ ...env, VERCEL: '1' }), /CRON_SECRET/);
  assert.throws(
    () => loadConfig({ ...vercelEnv, CRON_SECRET: 'short' }),
    /CRON_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...vercelEnv, WEB_ORIGINS: undefined }),
    /WEB_ORIGINS/,
  );
  assert.equal(loadConfig(vercelEnv).serverless, true);
});

test('serverless pool verifies TLS even when URL options request insecure SSL', async () => {
  const config = loadConfig({
    ...vercelEnv,
    DATABASE_URL: `${env.DATABASE_URL}?ssl=0&sslmode=no-verify&sslrootcert=missing-file`,
  });
  const options = databasePoolOptions(config);
  assert.equal(options.max, 1);
  assert.equal(options.connectionTimeoutMillis, 5000);
  // Check the actual pg client parsing too: URL SSL flags must not override TLS.
  const client = new pg.Client(options);
  assert.equal(typeof client.ssl, 'object');
  // @types/pg declares this as boolean, but pg retains the configured TLS object.
  const tls = client.ssl as unknown as {
    rejectUnauthorized: boolean;
    ca: string[];
  };
  assert.equal(tls.rejectUnauthorized, true);
  assert.ok(
    tls.ca.some((certificate) => certificate.includes('BEGIN CERTIFICATE')),
  );
  assert.deepEqual(
    databasePoolOptions({ ...config, databaseSslCa: 'custom-trusted-ca' }).ssl,
    { rejectUnauthorized: true, ca: 'custom-trusted-ca' },
  );
  assert.equal(databasePoolOptions(loadConfig(env)).max, 10);
});

test('job rejects missing/wrong/member/query credentials before invoking the worker', async () => {
  const app = Fastify();
  let calls = 0;
  registerNotificationJob(app, secret, async () => {
    calls++;
    return true;
  });
  try {
    for (const headers of [
      {},
      { authorization: 'Bearer member-jwt' },
      { authorization: `Bearer ${secret}wrong` },
    ]) {
      const response = await app.inject({
        url: '/internal/notifications/run',
        headers,
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(
      (await app.inject(`/internal/notifications/run?secret=${secret}`))
        .statusCode,
      401,
    );
    assert.equal(calls, 0);
    const response = await app.inject({
      url: '/internal/notifications/run',
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
  const disabled = Fastify();
  registerNotificationJob(disabled, null, async () => {
    throw new Error('must not run');
  });
  assert.equal(
    (await disabled.inject('/internal/notifications/run')).statusCode,
    401,
  );
  await disabled.close();
});

test('overlapping jobs do not report false success and a failed batch can be retried without leaking errors', async () => {
  let release: () => void = () => {};
  let calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = createNotificationRunner(async () => {
    calls++;
    await gate;
    if (calls === 1) throw new Error('private-database-password');
  });
  const app = Fastify();
  registerNotificationJob(app, secret, () => runner.run());
  const request = {
    url: '/internal/notifications/run',
    headers: { authorization: `Bearer ${secret}` },
  };
  try {
    await app.ready();
    const first = app.inject(request);
    // Wait for execution to start, then submit another invocation.
    while (!calls) await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await app.inject(request);
    assert.equal(second.statusCode, 503);
    assert.equal(second.headers['retry-after'], '60');
    assert.equal(calls, 1);
    release();
    const failed = await first;
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, 'JOB_FAILED');
    assert.ok(!failed.body.includes('private-database-password'));
    assert.equal((await app.inject(request)).statusCode, 200);
  } finally {
    release();
    await runner.drain();
    await app.close();
  }
});

test('production runtime boots health and rejects unauthorized jobs without opening database connections', async () => {
  const { app } = createRuntime(loadConfig(vercelEnv), Fastify);
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal(
      (await app.inject('/internal/notifications/run')).statusCode,
      401,
    );
    assert.equal((await app.inject('/v1/me')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'OPTIONS',
          url: '/v1/me',
          headers: {
            origin: 'https://example.test',
            'access-control-request-method': 'GET',
          },
        })
      ).headers['access-control-allow-origin'],
      'https://example.test',
    );
  } finally {
    await app.close();
  }
});

test('Gemini is enabled only with a private key and explicit free-tier confirmation', () => {
  assert.equal(
    loadConfig({ ...env, GEMINI_API_KEY: 'test-only' }).assistant,
    null,
  );
  assert.equal(
    loadConfig({ ...env, GEMINI_FREE_TIER_CONFIRMED: 'true' }).assistant,
    null,
  );
  assert.equal(
    loadConfig({ ...env, OPENAI_API_KEY: 'old-test-only' }).assistant,
    null,
  );
  assert.deepEqual(
    loadConfig({
      ...env,
      GEMINI_API_KEY: 'test-only',
      GEMINI_FREE_TIER_CONFIRMED: 'true',
    }).assistant,
    { apiKey: 'test-only' },
  );
});
