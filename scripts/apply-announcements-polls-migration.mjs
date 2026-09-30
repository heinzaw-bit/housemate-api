import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in api/.env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(`SELECT to_regclass('housemate.announcements') IS NOT NULL AS applied`);
  if (result.rows[0]?.applied) console.log('Announcements and polls migration is already applied.');
  else {
    await pool.query(await readFile(new URL('../sql/013_announcements_polls.sql', import.meta.url), 'utf8'));
    console.log('Announcements and polls migration applied.');
  }
} finally {
  await pool.end();
}
