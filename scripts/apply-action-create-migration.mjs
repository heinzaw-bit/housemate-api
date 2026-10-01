import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadConfig } from '../dist/config.js';
import { databasePoolOptions } from '../dist/database.js';
const pool = new pg.Pool(databasePoolOptions(loadConfig()));
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const columns = await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='housemate' AND table_name IN ('shopping_items','chores') AND column_name IN ('idempotency_key','request_hash')");
  if (columns.rows[0].count === 0) await client.query(await readFile(new URL('../supabase/migrations/20261001180100_action_create_idempotency.sql', import.meta.url), 'utf8'));
  else if (columns.rows[0].count !== 4) throw new Error('Partial migration');
  await client.query('COMMIT');
  console.log('Action creation idempotency migration ready.');
} catch {
  await client.query('ROLLBACK');
  console.error('Action creation migration failed; no private connection or provider details printed.');
  process.exitCode=1;
} finally { client.release(); await pool.end(); }
