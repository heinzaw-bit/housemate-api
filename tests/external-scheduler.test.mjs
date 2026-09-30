import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureJob,
  createProviderClient,
  desiredJob,
  findJob,
  jobUrl,
  summarize,
} from '../scripts/external-scheduler.mjs';

const url = 'https://api.example.test/internal/notifications/run';
const secret = 'private-test-secret';
const expected = () => desiredJob(url, 'Asia/Bangkok', secret);

test('scheduler refuses credential-bearing URLs and incomplete/duplicate inventories before writing', async () => {
  assert.throws(
    () => jobUrl('https://user:password@example.test'),
    /without credentials/,
  );
  assert.throws(() => jobUrl('http://example.test'), /HTTPS/);
  assert.throws(
    () => jobUrl('https://example.test/?token=private'),
    /without credentials/,
  );
  await assert.rejects(
    findJob(async () => ({ jobs: [], someFailed: true }), url),
    /incomplete/,
  );
  await assert.rejects(
    findJob(
      async () => ({
        jobs: [
          { jobId: 1, url },
          { jobId: 2, url },
        ],
        someFailed: false,
      }),
      url,
    ),
    /More than one/,
  );
  await assert.rejects(
    findJob(
      async () => ({
        jobs: [
          {
            jobId: 1,
            title: 'HouseMate notifications',
            url: 'https://other.example.test',
          },
        ],
        someFailed: false,
      }),
      url,
    ),
    /different URL/,
  );
});

test('setup verifies the saved authorization before enabling, and a rerun reuses the job', async () => {
  let stored = null;
  let creations = 0;
  const request = async (path, method = 'GET', body) => {
    if (path === '/jobs' && method === 'GET')
      return { jobs: stored ? [{ jobId: 7, url }] : [], someFailed: false };
    if (path === '/jobs' && method === 'PUT') {
      assert.equal(body.job.enabled, false);
      stored = { ...body.job, jobId: 7 };
      creations++;
      return { jobId: 7 };
    }
    if (method === 'PATCH') {
      if (body.job.enabled === true) {
        assert.equal(
          stored.extendedData.headers.Authorization,
          `Bearer ${secret}`,
        );
        assert.equal(stored.notification.mode, 2);
        assert.deepEqual(stored.notification.selectedChannels, [0]);
      }
      stored = { ...stored, ...body.job };
      return {};
    }
    return { jobDetails: stored };
  };
  assert.equal(await configureJob(request, expected()), 7);
  assert.equal(await configureJob(request, expected()), 7);
  assert.equal(creations, 1);
  assert.equal(stored.enabled, true);
});

test('incorrect saved credentials never enable the newly configured job', async () => {
  let enabled = false;
  const request = async (path, method = 'GET', body) => {
    if (path === '/jobs' && method === 'GET')
      return { jobs: [], someFailed: false };
    if (method === 'PUT') return { jobId: 8 };
    if (method === 'PATCH') enabled = body.job.enabled;
    return {
      jobDetails: {
        ...expected(),
        extendedData: { headers: { Authorization: 'Bearer wrong' } },
      },
    };
  };
  await assert.rejects(configureJob(request, expected()), /remains disabled/);
  assert.equal(enabled, false);
});

test('ambiguous creation does not automatically retry or create another job', async () => {
  let creations = 0;
  const request = async (_path, method = 'GET') => {
    if (method === 'GET') return { jobs: [], someFailed: false };
    creations++;
    throw new Error('Connection interrupted');
  };
  await assert.rejects(
    configureJob(request, expected()),
    /Connection interrupted/,
  );
  assert.equal(creations, 1);
});

test('provider errors redact both scheduler keys and private job headers', async () => {
  const key = 'private-api-key';
  const request = createProviderClient(
    key,
    async () => new Response(JSON.stringify({ secret }), { status: 403 }),
  );
  await assert.rejects(
    request('/jobs', 'PUT', { job: expected() }),
    (error) => {
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(secret), false);
      return /HTTP 403/.test(error.message);
    },
  );
  const interrupted = createProviderClient(key, async () => {
    throw new Error(`${key} ${secret}`);
  });
  await assert.rejects(
    interrupted('/jobs'),
    (error) => !error.message.includes(key) && !error.message.includes(secret),
  );
});

test('monitor detects a failed, stale, or disabled schedule while omitting secrets', () => {
  const now = Date.now();
  const job = {
    ...expected(),
    jobId: 9,
    enabled: true,
    lastStatus: 1,
    lastExecution: Math.floor(now / 1000),
    lastDuration: 150,
  };
  const report = summarize(job, expected(), now);
  assert.equal(report.healthy, true);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(
    summarize({ ...job, lastStatus: 5 }, expected(), now).healthy,
    false,
  );
  assert.equal(
    summarize(
      { ...job, lastExecution: Math.floor(now / 1000) - 181 },
      expected(),
      now,
    ).stale,
    true,
  );
  assert.equal(
    summarize({ ...job, enabled: false }, expected(), now).healthy,
    false,
  );
  assert.equal(
    summarize(
      { ...job, notification: { ...job.notification, onFailure: false } },
      expected(),
      now,
    ).healthy,
    false,
  );
});
