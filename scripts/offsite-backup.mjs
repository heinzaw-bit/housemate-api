import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { del, get, list, put } from '@vercel/blob';
import { createBackup, recoveryKey, unseal } from './backup.mjs';

export const prefix = 'housemate/production/v1/';
export const storageBudget = 256 * 1024 * 1024;
export const maxBackupBytes = 16 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function verifyArchive(bytes, key) {
  if (!bytes.length || bytes.length > maxBackupBytes)
    throw new Error('Encrypted archive exceeds the unattended backup limit');
  const payload = JSON.parse(unseal(bytes, key).toString());
  if (
    payload.manifest?.version !== 1 ||
    hash(Buffer.from(payload.archive, 'base64')) !==
      payload.manifest.archiveSha256 ||
    !Array.isArray(payload.manifest.tables) ||
    JSON.stringify(payload.manifest.schemas) !==
      '["housemate","auth","storage"]' ||
    typeof payload.manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.manifest.createdAt)) ||
    new Date(payload.manifest.createdAt).toISOString() !==
      payload.manifest.createdAt
  )
    throw new Error('Encrypted archive failed integrity validation');
  if (Number(payload.manifest.storageObjectCount) !== 0)
    throw new Error(
      'Storage object files require a separate backup before unattended backups can be considered complete',
    );
  return payload.manifest;
}

export function backupDate(pathname) {
  const match =
    /^housemate\/production\/v1\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.hmbak$/.exec(
      pathname,
    );
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso
    ? date
    : null;
}

export function retentionPlan(blobs) {
  const managed = blobs
    .filter((blob) => backupDate(blob.pathname))
    .sort((a, b) => backupDate(b.pathname) - backupDate(a.pathname));
  const keep = new Set();
  for (const [kind, limit] of [
    ['day', 7],
    ['week', 4],
    ['month', 3],
  ]) {
    const buckets = new Set();
    for (const blob of managed) {
      const bangkok = new Date(
        backupDate(blob.pathname).getTime() + 7 * 3600000,
      );
      if (kind === 'week')
        bangkok.setUTCDate(bangkok.getUTCDate() - bangkok.getUTCDay());
      const bucket = bangkok.toISOString().slice(0, kind === 'month' ? 7 : 10);
      if (buckets.has(bucket) || buckets.size >= limit) continue;
      buckets.add(bucket);
      keep.add(blob.pathname);
    }
  }
  return {
    keep: managed.filter((blob) => keep.has(blob.pathname)),
    remove: managed.filter((blob) => !keep.has(blob.pathname)),
  };
}

export async function inventory(client) {
  const blobs = [];
  let cursor;
  do {
    const page = await client.list({ limit: 1000, cursor });
    if (
      !Array.isArray(page.blobs) ||
      page.blobs.some(
        (blob) => !Number.isSafeInteger(blob.size) || blob.size < 0,
      ) ||
      (page.hasMore && (!page.cursor || page.cursor === cursor))
    )
      throw new Error('Backup store inventory is incomplete');
    blobs.push(...page.blobs);
    if (blobs.length > 10000)
      throw new Error('Backup store inventory is too large');
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function boundedBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBackupBytes)
        throw new Error('Downloaded archive exceeds the backup limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function uploadVerified(bytes, key, client) {
  const manifest = verifyArchive(bytes, key);
  const age = Date.now() - Date.parse(manifest.createdAt);
  if (age < -60000 || age > 86400000)
    throw new Error('Only a fresh backup can update offsite retention');
  const before = await inventory(client);
  if (
    before.reduce((sum, blob) => sum + blob.size, 0) + bytes.length >
    storageBudget
  )
    throw new Error(
      'Backup storage headroom is insufficient; existing backups were preserved',
    );
  const pathname =
    prefix + manifest.createdAt.replaceAll(/[:.]/g, '-') + '.hmbak';
  const uploaded = await client.put(pathname, bytes, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/octet-stream',
  });
  if (
    uploaded.pathname !== pathname ||
    !new URL(uploaded.url).hostname.endsWith('.private.blob.vercel-storage.com')
  )
    throw new Error(
      'Upload did not return the expected private backup location',
    );
  const fetched = await client.get(pathname, {
    access: 'private',
    useCache: false,
  });
  if (fetched?.statusCode !== 200)
    throw new Error('Uploaded backup could not be read back');
  const downloaded = await boundedBytes(fetched.stream);
  if (hash(downloaded) !== hash(bytes))
    throw new Error('Offsite download checksum did not match');
  verifyArchive(downloaded, key);
  const anonymous = await client.anonymous(uploaded.url);
  if (![401, 403, 404].includes(anonymous.status))
    throw new Error('Backup URL did not deny anonymous access');
  await anonymous.body?.cancel();
  const after = await inventory(client);
  if (
    !after.some(
      (blob) => blob.pathname === pathname && blob.size === bytes.length,
    )
  )
    throw new Error(
      'Verified upload is missing from the store inventory; retention was skipped',
    );
  const plan = retentionPlan(after);
  if (!plan.keep.some((blob) => blob.pathname === pathname))
    throw new Error(
      'Fresh backup was not selected by retention; cleanup stopped',
    );
  for (const blob of plan.remove) await client.del(blob.pathname);
  return {
    createdAt: manifest.createdAt,
    encrypted: true,
    bytes: bytes.length,
    downloadChecksumVerified: true,
    encryptedArchiveVerified: true,
    anonymousAccessDenied: true,
    tableCount: manifest.tables.length,
    retainedBackups: plan.keep.length,
    removedBackups: plan.remove.length,
    retainedBytes:
      after.reduce((sum, blob) => sum + blob.size, 0) -
      plan.remove.reduce((sum, blob) => sum + blob.size, 0),
    pathname,
  };
}

function clientFor(token) {
  if (!token || !/^vercel_blob_rw_[A-Za-z0-9]+_/.test(token))
    throw new Error('Private backup store credentials are missing');
  const options = () => ({ token, abortSignal: AbortSignal.timeout(60000) });
  return {
    list: (args) => list({ ...args, ...options() }),
    put: (path, bytes, args) => put(path, bytes, { ...args, ...options() }),
    get: (path, args) => get(path, { ...args, ...options() }),
    del: (path) => del(path, options()),
    anonymous: (url) =>
      fetch(url, {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      }),
  };
}

async function main() {
  const file = resolve(import.meta.dirname, '../.env.backup');
  const local = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const client = clientFor(
    process.env.BLOB_READ_WRITE_TOKEN || local.BLOB_READ_WRITE_TOKEN,
  );
  const mode = process.argv[2];
  if (mode === 'status') {
    const blobs = await inventory(client);
    const managed = retentionPlan(blobs).keep;
    const latest = managed[0];
    const fresh =
      !!latest &&
      Date.now() - backupDate(latest.pathname).getTime() < 36 * 3600000;
    console.log(
      JSON.stringify({
        backupCount: blobs.filter((b) => backupDate(b.pathname)).length,
        bytes: blobs.reduce((sum, b) => sum + b.size, 0),
        latestAt: latest ? backupDate(latest.pathname).toISOString() : null,
        fresh,
        storageBudgetBytes: storageBudget,
      }),
    );
    if (!fresh) process.exitCode = 1;
    return;
  }
  if (mode === 'drill') {
    const latest = retentionPlan(await inventory(client)).keep[0];
    if (
      !latest ||
      Date.now() - backupDate(latest.pathname).getTime() > 36 * 3600000
    )
      throw new Error(
        'A recent offsite backup is required for the restore drill',
      );
    const remote = await client.get(latest.pathname, {
      access: 'private',
      useCache: false,
    });
    if (remote?.statusCode !== 200)
      throw new Error('Offsite backup download failed');
    const bytes = await boundedBytes(remote.stream);
    verifyArchive(bytes, recoveryKey());
    const destination = resolve(
      import.meta.dirname,
      '../.run/backups/offsite-restore.hmbak',
    );
    mkdirSync(resolve(import.meta.dirname, '../.run/backups'), {
      recursive: true,
    });
    writeFileSync(destination, bytes, { mode: 0o600 });
    await new Promise((fulfill, reject) => {
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, 'backup.mjs'), 'drill', destination],
        { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true },
      );
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Offsite restore drill timed out'));
      }, 600000);
      child.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('Offsite restore drill could not start'));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        code === 0
          ? fulfill()
          : reject(new Error('Offsite restore drill failed'));
      });
    });
    return;
  }
  if (mode !== 'run') throw new Error('Use run, status or drill');
  const report = await createBackup();
  const uploaded = await uploadVerified(
    readFileSync(report.backup),
    recoveryKey(),
    client,
  );
  writeFileSync(
    resolve(import.meta.dirname, '../.run/offsite-backup.json'),
    JSON.stringify(uploaded, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ ...uploaded, localBackup: report.backup }, null, 2),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    console.error(
      'Offsite backup failed. Existing verified backups were preserved unless verified retention cleanup had begun. Check configuration, TLS, database reachability and storage limits; private details withheld.',
    );
    process.exitCode = 1;
  });
