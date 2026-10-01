import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgAssistantBudget } from '../dist/assistant-budget.js';
import { loadConfig } from '../dist/config.js';
import { databasePoolOptions } from '../dist/database.js';

const pool = new pg.Pool(databasePoolOptions(loadConfig()));
let client;
try {
  client = await pool.connect();
  const protection = await client.query(`SELECT c.relrowsecurity,
    has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
    has_table_privilege('authenticated', c.oid, 'INSERT') AS client_write
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'housemate' AND c.relname = 'assistant_usage'`);
  assert.equal(protection.rows[0]?.relrowsecurity, true);
  assert.equal(protection.rows[0]?.anon_read, false);
  assert.equal(protection.rows[0]?.client_write, false);
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('housemate.assistant.budget', 0))");
  const time = (await client.query("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD-HH24') AS hour")).rows[0];
  const user = randomUUID();
  const dayKey = `day:${time.day}`;
  const userKey = `user:${user}:${time.hour}`;
  // Test counters only inside the outer rollback. No provider requests or household writes.
  await client.query(`INSERT INTO housemate.assistant_usage (bucket, requests, expires_at)
    VALUES ($1, 1, now() + interval '1 day') ON CONFLICT (bucket) DO UPDATE SET requests = 1`, [dayKey]);
  const budget = new PgAssistantBudget({ connect: async () => ({
    query: async (text, values) => client.query(text === 'BEGIN' ? 'SAVEPOINT budget_attempt' : text === 'COMMIT' ? 'RELEASE SAVEPOINT budget_attempt' : text === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT budget_attempt' : text, values),
    release: () => {},
  }) });
  await budget.consume(user);
  assert.equal((await client.query('SELECT requests FROM housemate.assistant_usage WHERE bucket = $1', [userKey])).rows[0].requests, 1);
  await client.query('UPDATE housemate.assistant_usage SET requests = 20 WHERE bucket = $1', [userKey]);
  await assert.rejects(() => budget.consume(user), (error) => error.code === 'AI_LIMIT_REACHED');
  assert.equal((await client.query('SELECT requests FROM housemate.assistant_usage WHERE bucket = $1', [dayKey])).rows[0].requests, 2);
  await client.query('UPDATE housemate.assistant_usage SET requests = 200 WHERE bucket = $1', [dayKey]);
  await assert.rejects(() => budget.consume(randomUUID()), (error) => error.code === 'AI_LIMIT_REACHED');
  console.log('Assistant database checks passed: private RLS table, atomic counters, account and global limits. All test changes rolled back.');
} catch {
  console.error('Assistant database checks failed. Details withheld; inspect configuration and the usage migration.');
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
