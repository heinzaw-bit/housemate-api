import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

const directory = fileURLToPath(new URL('../', import.meta.url));
const runDirectory = resolve(directory, '.run');
const magic = Buffer.from('HOUSEMATE01');
const maxBytes = 512 * 1024 * 1024;
const schemas = ['housemate', 'auth', 'storage'];
const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';

// A schema-filtered pg_restore can omit the namespace creation itself.
function recoverySchemaSql(sql) {
  return /CREATE SCHEMA (?:"housemate"|housemate);/.test(sql.toString())
    ? sql
    : Buffer.concat([Buffer.from('CREATE SCHEMA housemate;\n'), sql]);
}

export function seal(payload, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(magic);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([magic, nonce, cipher.getAuthTag(), encrypted]);
}

export function unseal(bytes, key) {
  if (!bytes.subarray(0, magic.length).equals(magic))
    throw new Error('Unrecognized backup format');
  const offset = magic.length;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    bytes.subarray(offset, offset + 12),
  );
  decipher.setAAD(magic);
  decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(offset + 28)),
    decipher.final(),
  ]);
}

function binary(name) {
  const bin =
    process.env.PG_BIN ||
    (process.platform === 'win32'
      ? resolve(runDirectory, 'tools/pg17/pgsql/bin')
      : '/usr/lib/postgresql/17/bin');
  return resolve(bin, name + (process.platform === 'win32' ? '.exe' : ''));
}

function command(name, args, env = {}, input) {
  return new Promise((fulfill, reject) => {
    const child = spawn(binary(name), args, {
      windowsHide: true,
      env: { ...process.env, ...env },
      // pg_ctl's server descendants otherwise keep inherited Windows pipes open.
      stdio: name === 'pg_ctl' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
    });
    let size = 0;
    let sqlState = '';
    let missingSchema = '';
    const chunks = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} timed out`));
    }, 300000);
    child.stdout?.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) child.kill();
      else chunks.push(chunk);
    });
    // Raw PostgreSQL errors can contain rows, credentials and private query text.
    child.stderr?.on('data', (chunk) => {
      // With psql VERBOSITY=sqlstate, retain only the five-character error code.
      // Never expose raw SQL, record data, keys or provider/database messages.
      const match = chunk.toString().match(/ERROR:\s+([A-Z0-9]{5})\b/);
      if (match) sqlState = match[1];
      const schema = chunk
        .toString()
        .match(/schema "([a-z_]+)" does not exist/);
      if (
        schema &&
        ['housemate', 'auth', 'storage', 'extensions', 'public'].includes(
          schema[1],
        )
      )
        missingSchema = schema[1];
    });
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new Error(`${name} could not start; check PG_BIN`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || size > maxBytes)
        reject(
          new Error(
            `${name} failed (exit ${code}${sqlState ? `, SQLSTATE ${sqlState}` : ''}${missingSchema ? `, missing schema ${missingSchema}` : ''}); private details withheld`,
          ),
        );
      else fulfill(Buffer.concat(chunks));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export function recoveryKey(create = false) {
  if (process.env.BACKUP_RECOVERY_KEY_BASE64) {
    const encoded = process.env.BACKUP_RECOVERY_KEY_BASE64;
    const value = Buffer.from(encoded, 'base64');
    if (value.length !== 32 || value.toString('base64') !== encoded)
      throw new Error('The recovery key must be canonical base64 for 32 bytes');
    return value;
  }
  const path =
    process.env.BACKUP_KEY_FILE || resolve(runDirectory, 'keys/backup.key');
  if (!existsSync(path) && create) {
    mkdirSync(resolve(runDirectory, 'keys'), { recursive: true });
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const value = readFileSync(path);
  if (value.length !== 32)
    throw new Error('The recovery key must be exactly 32 bytes');
  return value;
}

function pgEnvironment(url) {
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '10',
    PGOPTIONS:
      '-c default_transaction_read_only=on -c statement_timeout=120000',
  };
}

async function checks(client, tables) {
  await client.query("SET TIME ZONE 'UTC'");
  const output = [];
  for (const table of tables) {
    const name = `${identifier(table.schema)}.${identifier(table.name)}`;
    const result = await client.query(
      `SELECT count(*)::text AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest FROM ${name} t`,
    );
    output.push({ ...table, ...result.rows[0] });
  }
  return output;
}

export async function createBackup() {
  const { databasePoolOptions } = await import('../dist/database.js');
  const { supabaseDatabaseCa } = await import('../dist/supabase-ca.js');
  const env = process.env.BACKUP_DATABASE_URL
    ? {}
    : parseEnv(readFileSync(resolve(directory, '.env.vercel'), 'utf8'));
  const config = {
    databaseUrl: process.env.BACKUP_DATABASE_URL || env.DATABASE_URL,
    databaseSslCa: process.env.BACKUP_DATABASE_SSL_CA || env.DATABASE_SSL_CA,
    serverless: true,
  };
  if (!config.databaseUrl)
    throw new Error('Backup database configuration is missing');
  // Validate an existing recovery key before reading production data. Cloud runs
  // must never generate a new, unrecoverable key on an ephemeral runner.
  const encryptionKey = recoveryKey(process.env.CI !== 'true');
  const client = new pg.Client({
    ...databasePoolOptions(config),
    query_timeout: 120000,
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await client.query('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0].snapshot;
    const tables = (
      await client.query(
        `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p') ORDER BY 1,2`,
        [schemas],
      )
    ).rows;
    const roles = (
      await client.query(
        "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' AND rolname <> 'postgres' ORDER BY rolname",
      )
    ).rows.map((row) => row.rolname);
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourcePostgresVersion: (await client.query('SHOW server_version')).rows[0]
        .server_version,
      schemas,
      roles,
      tables: await checks(client, tables),
      extensions: (
        await client.query('SELECT extname FROM pg_extension ORDER BY extname')
      ).rows.map((row) => row.extname),
      storageObjectCount: (
        await client.query(
          'SELECT count(*)::text AS count FROM storage.objects',
        )
      ).rows[0].count,
    };
    const caPath = resolve(runDirectory, 'database-ca.crt');
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(caPath, config.databaseSslCa || supabaseDatabaseCa);
    const pgEnv = {
      ...pgEnvironment(new URL(config.databaseUrl)),
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: caPath,
    };
    const archive = await command(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--snapshot=' + snapshot,
        ...schemas.map((schema) => '--schema=' + schema),
      ],
      pgEnv,
    );
    manifest.archiveSha256 = createHash('sha256').update(archive).digest('hex');
    await client.query('COMMIT');
    const payload = Buffer.from(
      JSON.stringify({ manifest, archive: archive.toString('base64') }),
    );
    const destination = resolve(
      runDirectory,
      'backups',
      `housemate-${manifest.createdAt.replaceAll(/[:.]/g, '-')}.hmbak`,
    );
    mkdirSync(resolve(runDirectory, 'backups'), { recursive: true });
    writeFileSync(destination, seal(payload, encryptionKey), {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      backup: destination,
      encrypted: true,
      schemas,
      tableCount: tables.length,
      storageObjects: Number(manifest.storageObjectCount),
      note: 'Copy backup offsite and keep the recovery key separately. Storage object bytes are not included.',
    };
  } finally {
    await client.end();
  }
}

async function drill(path) {
  const started = Date.now();
  const payload = JSON.parse(
    unseal(readFileSync(resolve(path)), recoveryKey()).toString(),
  );
  const archive = Buffer.from(payload.archive, 'base64');
  const manifest = payload.manifest;
  if (
    manifest.version !== 1 ||
    createHash('sha256').update(archive).digest('hex') !==
      manifest.archiveSha256
  )
    throw new Error('Backup integrity check failed');
  const id = randomUUID();
  const drillRoot = resolve(runDirectory, 'restore-drills', id);
  const cluster = resolve(drillRoot, 'data');
  const password = randomBytes(32).toString('base64url');
  mkdirSync(drillRoot, { recursive: true });
  const passwordPath = resolve(drillRoot, 'password');
  writeFileSync(passwordPath, password, { mode: 0o600 });
  // Each drill initializes a brand-new cluster; callers cannot supply a restore DB URL.
  console.log('Restore stage: initialize isolated PostgreSQL');
  await command('initdb', [
    '-D',
    cluster,
    '-U',
    'postgres',
    '--auth=scram-sha-256',
    '--pwfile=' + passwordPath,
    '--encoding=UTF8',
    '--locale=C',
  ]);
  const port = 55432 + Math.floor(Math.random() * 900);
  let running = false;
  let client;
  try {
    console.log('Restore stage: start isolated PostgreSQL');
    await command('pg_ctl', [
      '-D',
      cluster,
      '-l',
      resolve(drillRoot, 'postgres.log'),
      '-o',
      // Debian's default socket directory belongs to the system postgres user.
      // This disposable cluster uses TCP loopback only, including on CI runners.
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`,
      '-w',
      'start',
    ]);
    running = true;
    const options = {
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: 'postgres',
      password,
      connectionTimeoutMillis: 5000,
    };
    client = new pg.Client(options);
    await client.connect();
    for (const role of manifest.roles)
      await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN`);
    await client.query('CREATE SCHEMA extensions');
    await client.query('CREATE EXTENSION pgcrypto WITH SCHEMA extensions');
    await client.query('CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions');
    console.log('Restore stage: restore archive and verify snapshot');
    const restoreEnv = {
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGDATABASE: 'postgres',
      PGUSER: 'postgres',
      PGPASSWORD: password,
      PGSSLMODE: 'disable',
      PGOPTIONS: '',
    };
    await command(
      'pg_restore',
      [
        '--dbname=postgres',
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
      ],
      restoreEnv,
      archive,
    );
    const restored = await checks(client, manifest.tables);
    if (JSON.stringify(restored) !== JSON.stringify(manifest.tables))
      throw new Error(
        'Restored row counts or checksums differ from the captured snapshot',
      );
    const broken = (
      await client.query(
        `SELECT count(*)::text AS count FROM housemate.users u LEFT JOIN auth.users a ON a.id=u.auth_user_id WHERE a.id IS NULL`,
      )
    ).rows[0].count;
    if (broken !== '0') throw new Error('Restored identity references failed');
    const rls = (
      await client.query(
        `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='housemate' AND c.relkind='r' AND NOT c.relrowsecurity`,
      )
    ).rows[0].count;
    if (rls !== '0')
      throw new Error('Restored private tables lost row-level security');
    await client.end();
    client = undefined;
    // Exercise the actual money, authorization, edits and audit repositories against the restored data.
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
    console.log('Restore stage: verify API and financial history');
    for (const script of [
      'smoke-dashboard.mjs',
      'smoke-financial-edits.mjs',
      'smoke-financial-voids.mjs',
    ]) {
      await new Promise((fulfill, reject) => {
        const child = spawn(
          process.execPath,
          [resolve(directory, 'scripts', script)],
          {
            windowsHide: true,
            env: { ...process.env, DATABASE_URL: connectionString },
            stdio: 'ignore',
          },
        );
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('Restored API smoke check timed out'));
        }, 60000);
        child.on('error', () => {
          clearTimeout(timeout);
          reject(new Error('Restored API smoke check could not start'));
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          code === 0
            ? fulfill()
            : reject(new Error('Restored API smoke check failed: ' + script));
        });
      });
    }
    // Also test the recovery runbook with already-provisioned managed schemas.
    console.log('Restore stage: verify managed-schema recovery SQL');
    client = new pg.Client(options);
    await client.connect();
    await client.query('DROP SCHEMA housemate CASCADE');
    const managedTables = manifest.tables.filter(
      (table) => table.schema !== 'housemate',
    );
    await client.query(
      `TRUNCATE ${managedTables.map((table) => `${identifier(table.schema)}.${identifier(table.name)}`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    await client.end();
    client = undefined;
    const schemaSql = await command(
      'pg_restore',
      [
        '--file=-',
        '--schema-only',
        '--schema=housemate',
        '--no-owner',
        '--no-acl',
      ],
      {},
      archive,
    );
    const dataSql = await command(
      'pg_restore',
      ['--file=-', '--data-only', '--no-owner', '--no-acl'],
      {},
      archive,
    );
    const recoverySql = Buffer.concat([
      recoverySchemaSql(schemaSql),
      Buffer.from('\nSET session_replication_role=replica;\n'),
      dataSql,
      Buffer.from(
        '\nSET session_replication_role=origin;\nREVOKE ALL ON SCHEMA housemate FROM PUBLIC, anon, authenticated, service_role;\n',
      ),
    ]);
    await command(
      'psql',
      [
        '--no-psqlrc',
        '--single-transaction',
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=sqlstate',
      ],
      restoreEnv,
      recoverySql,
    );
    client = new pg.Client(options);
    await client.connect();
    if (
      JSON.stringify(await checks(client, manifest.tables)) !==
      JSON.stringify(manifest.tables)
    )
      throw new Error('Managed-schema recovery SQL did not match the snapshot');
    await client.end();
    client = undefined;
    const report = {
      testedAt: new Date().toISOString(),
      backupCreatedAt: manifest.createdAt,
      encryptedArchiveVerified: true,
      tableCount: restored.length,
      allRowsAndChecksumsMatch: true,
      managedSchemaRecoverySqlVerifiedLocally: true,
      identityReferencesValid: true,
      privateTablesRlsEnabled: true,
      apiChecks: [
        'dashboard/balances/household isolation',
        'financial edits/history',
        'financial voids/history',
      ],
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      target: 'Fresh isolated local PostgreSQL 17 cluster',
      limitations: [
        'No Supabase Auth service or OAuth/email delivery test',
        'No Storage object bytes',
        'Production cutover not performed',
      ],
      drillDirectory: drillRoot,
    };
    writeFileSync(
      resolve(drillRoot, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client?.end().catch(() => {});
    if (running)
      await command('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']);
  }
}

async function unpack(path) {
  const payload = JSON.parse(
    unseal(readFileSync(resolve(path)), recoveryKey()).toString(),
  );
  const archive = Buffer.from(payload.archive, 'base64');
  if (
    payload.manifest.version !== 1 ||
    createHash('sha256').update(archive).digest('hex') !==
      payload.manifest.archiveSha256
  )
    throw new Error('Backup integrity check failed');
  const destination = resolve(runDirectory, 'recovery', randomUUID());
  mkdirSync(destination, { recursive: true });
  // Supabase provisions managed auth/storage schemas; recover their data, not their DDL.
  const schemaSql = await command(
    'pg_restore',
    [
      '--file=-',
      '--schema-only',
      '--schema=housemate',
      '--no-owner',
      '--no-acl',
    ],
    {},
    archive,
  );
  const dataSql = await command(
    'pg_restore',
    ['--file=-', '--data-only', '--no-owner', '--no-acl'],
    {},
    archive,
  );
  writeFileSync(
    resolve(destination, 'schema.sql'),
    recoverySchemaSql(schemaSql),
    { mode: 0o600 },
  );
  writeFileSync(resolve(destination, 'data.sql'), dataSql, { mode: 0o600 });
  writeFileSync(
    resolve(destination, 'manifest.json'),
    JSON.stringify(payload.manifest, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        destination,
        note: 'Private decrypted files. Restore only into an explicitly reviewed NEW target; follow OPERATIONS.md.',
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const operation = process.argv[2];
  Promise.resolve()
    .then(() => {
      if (operation === 'create')
        return createBackup().then((report) =>
          console.log(JSON.stringify(report, null, 2)),
        );
      if (operation === 'drill' && process.argv[3])
        return drill(process.argv[3]);
      if (operation === 'unpack' && process.argv[3])
        return unpack(process.argv[3]);
      throw new Error(
        'Use create, drill <backup-path>, or unpack <backup-path>',
      );
    })
    .catch((error) => {
      console.error(
        error instanceof Error && !('code' in error)
          ? error.message
          : 'Backup/restore failed; private database details withheld.',
      );
      process.exitCode = 1;
    });
}
