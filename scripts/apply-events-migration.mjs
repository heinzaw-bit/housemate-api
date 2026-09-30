import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in api/.env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(`SELECT to_regclass('housemate.events') IS NOT NULL AS applied`);
  if (result.rows[0]?.applied) console.log('Events migration is already applied.');
  else {
    const sql = await readFile(new URL('../sql/012_events.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('Events migration applied.');
  }
} finally {
  await pool.end();
}
