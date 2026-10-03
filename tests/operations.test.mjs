import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { seal, unseal } from '../scripts/backup.mjs';
import { configurationMatches } from '../scripts/external-scheduler.mjs';
import { migrateWebCheck, uptimeJobs } from '../scripts/uptime.mjs';

test('encrypted backups reject the wrong recovery key and tampering', () => {
  const key = randomBytes(32);
  const data = Buffer.from('Private household records');
  const encrypted = seal(data, key);
  assert.ok(!encrypted.includes(data));
  assert.deepEqual(unseal(encrypted, key), data);
  assert.throws(() => unseal(encrypted, randomBytes(32)));
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => unseal(encrypted, key));
});

test('web monitor migration preserves the existing job and rejects unrelated URLs', async () => {
  const expected = uptimeJobs('https://api.test', 'https://web.test')[1];
  let url = 'https://web.test/';
  const writes = [];
  const request = async (path, method = 'GET', body) => {
    if (path === '/jobs')
      return {
        someFailed: false,
        jobs: [{ jobId: 9, title: expected.title, url }],
      };
    if (method === 'GET')
      return {
        jobDetails: {
          title: expected.title,
          url,
          extendedData: { headers: {} },
          auth: { enable: false },
        },
      };
    writes.push(body);
    url = body.job.url;
    return {};
  };
  await migrateWebCheck(request, expected);
  assert.deepEqual(writes, [{ job: { url: expected.url, enabled: false } }]);
  url = 'https://different-owner.test/';
  await assert.rejects(migrateWebCheck(request, expected));
  assert.equal(writes.length, 1);
});

test('uptime jobs run every five minutes with owner alerts and no credentials', () => {
  const jobs = uptimeJobs('https://api.test', 'https://web.test');
  assert.equal(jobs[0].url, 'https://api.test/health/ready');
  assert.equal(jobs[0].requestMethod, 0);
  assert.equal(jobs[1].requestMethod, 0);
  assert.equal(jobs[1].url, 'https://web.test/api/health');
  for (const job of jobs) {
    assert.equal(job.schedule.minutes.length, 12);
    assert.deepEqual(job.extendedData.headers, {});
    assert.ok(configurationMatches(job, job, true));
    assert.ok(!configurationMatches({ ...job, requestMethod: 1 }, job, true));
    assert.ok(
      !configurationMatches(
        { ...job, extendedData: { headers: { Authorization: 'private' } } },
        job,
        true,
      ),
    );
    assert.ok(
      !configurationMatches(
        { ...job, schedule: { ...job.schedule, minutes: [-1] } },
        job,
        true,
      ),
    );
  }
});
