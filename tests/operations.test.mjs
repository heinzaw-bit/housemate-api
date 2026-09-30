import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { seal, unseal } from '../scripts/backup.mjs';
import { configurationMatches } from '../scripts/external-scheduler.mjs';
import { uptimeJobs } from '../scripts/uptime.mjs';

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

test('uptime jobs run every five minutes with owner alerts and no credentials', () => {
  const jobs = uptimeJobs('https://api.test', 'https://web.test');
  assert.equal(jobs[0].url, 'https://api.test/health/ready');
  for (const job of jobs) {
    assert.equal(job.schedule.minutes.length, 12);
    assert.deepEqual(job.extendedData.headers, {});
    assert.ok(configurationMatches(job, job, true));
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
