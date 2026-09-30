import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in api/.env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(`SELECT to_regclass('housemate.settlements') IS NOT NULL AS settlements`);
  if (result.rows[0]?.settlements) console.log('Settlement migration is already applied.');
  else {
    const sql = await readFile(new URL('../sql/005_manual_settlements.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('Settlement migration applied.');
  }
} finally {
  await pool.end();
}
