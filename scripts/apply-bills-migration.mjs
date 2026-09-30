import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in api/.env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(`SELECT
    to_regclass('housemate.bills') IS NOT NULL AS bills,
    to_regclass('housemate.bill_shares') IS NOT NULL AS shares,
    to_regclass('housemate.bill_status_events') IS NOT NULL AS events`);
  const state = result.rows[0];
  if (state?.bills && state?.shares && state?.events) console.log('Bill migration is already applied.');
  else if (state?.bills || state?.shares || state?.events) throw new Error('Bill migration is partially applied. Inspect the database before retrying.');
  else {
    const sql = await readFile(new URL('../sql/004_hybrid_bills.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('Bill migration applied.');
  }
} finally {
  await pool.end();
}
