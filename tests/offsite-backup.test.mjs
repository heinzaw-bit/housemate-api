import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { seal } from '../scripts/backup.mjs';
import {
  backupDate,
  inventory,
  prefix,
  retentionPlan,
  storageBudget,
  uploadVerified,
  verifyArchive,
} from '../scripts/offsite-backup.mjs';

const path = (date) =>
  `${prefix + date.toISOString().replaceAll(/[:.]/g, '-')}.hmbak`;
function archive(key, overrides = {}) {
  const bytes = Buffer.from('a private archive');
  return seal(
    Buffer.from(
      JSON.stringify({
        archive: bytes.toString('base64'),
        manifest: {
          version: 1,
          createdAt: new Date().toISOString(),
          schemas: ['housemate', 'auth', 'storage'],
          tables: [],
          storageObjectCount: '0',
          archiveSha256: createHash('sha256').update(bytes).digest('hex'),
          ...overrides,
        },
      }),
    ),
    key,
  );
}

test('retention preserves daily/weekly/monthly recovery points and ignores unrelated files', () => {
  const blobs = Array.from({ length: 120 }, (_, day) => ({
    pathname: path(new Date(Date.UTC(2026, 9, 3 - day, 20, 17))),
    size: 100,
  }));
  const foreign = { pathname: 'other-owner/private.hmbak', size: 10 };
  const plan = retentionPlan([...blobs, foreign]);
  assert.ok(plan.keep.length <= 14);
  assert.ok(plan.keep.includes(blobs[0]));
  assert.ok(plan.keep.some((b) => backupDate(b.pathname).getUTCMonth() === 7));
  assert.ok(!plan.remove.includes(foreign));
  assert.equal(plan.keep.length + plan.remove.length, 120);
  assert.equal(backupDate(`${prefix}2026-02-31T00-00-00-000Z.hmbak`), null);
  assert.equal(backupDate('other/2026-10-03T00-00-00-000Z.hmbak'), null);
});

test('unattended archives reject incomplete Storage backups and corrupted checksums', () => {
  const key = randomBytes(32);
  assert.equal(verifyArchive(archive(key), key).version, 1);
  assert.throws(() =>
    verifyArchive(archive(key, { storageObjectCount: '1' }), key),
  );
  assert.throws(() =>
    verifyArchive(archive(key, { archiveSha256: 'wrong' }), key),
  );
});

test('pagination fails closed before retention for incomplete inventories', async () => {
  await assert.rejects(
    inventory({ list: async () => ({ blobs: [], hasMore: true }) }),
  );
  await assert.rejects(
    inventory({ list: async () => ({ blobs: [{ size: -1 }] }) }),
  );
});

test('offsite retention only runs after a matching authenticated private download', async () => {
  const key = randomBytes(32);
  const bytes = archive(key);
  let stored;
  let deleted = 0;
  let tamper = false;
  const old = { pathname: path(new Date('2025-01-01T00:00:00Z')), size: 10 };
  const client = {
    list: async () => ({
      blobs: stored ? [old, stored] : [old],
      hasMore: false,
    }),
    put: async (pathname, input, options) => {
      assert.equal(options.access, 'private');
      assert.equal(options.allowOverwrite, false);
      stored = { pathname, size: input.length };
      return {
        pathname,
        url: `https://owned.private.blob.vercel-storage.com/${pathname}`,
      };
    },
    get: async () => ({
      statusCode: 200,
      stream: new Response(tamper ? Buffer.from('wrong') : bytes).body,
    }),
    anonymous: async () => new Response(null, { status: 403 }),
    del: async () => {
      deleted++;
    },
  };
  tamper = true;
  await assert.rejects(uploadVerified(bytes, key, client));
  assert.equal(deleted, 0);
  tamper = false;
  const report = await uploadVerified(bytes, key, client);
  assert.equal(report.downloadChecksumVerified, true);
  assert.equal(report.anonymousAccessDenied, true);
  client.anonymous = async () => new Response(null, { status: 200 });
  await assert.rejects(uploadVerified(bytes, key, client));
  assert.equal(deleted, 0);
  client.list = async () => ({
    blobs: [{ size: storageBudget, pathname: 'foreign' }],
    hasMore: false,
  });
  await assert.rejects(uploadVerified(bytes, key, client));
  assert.equal(deleted, 0);
});
