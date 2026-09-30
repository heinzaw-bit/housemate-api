import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in api/.env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'housemate'
      AND table_name = 'shopping_items' AND column_name = 'currency') AS applied`);
  if (result.rows[0]?.applied) console.log('Shopping currency migration is already applied.');
  else {
    const sql = await readFile(new URL('../sql/010_shopping_currency.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('Shopping currency migration applied.');
  }
} finally {
  await pool.end();
}
