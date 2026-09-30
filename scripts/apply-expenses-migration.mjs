import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in api/.env.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const status = await pool.query(`SELECT
    to_regclass('housemate.expenses') IS NOT NULL AS expenses,
    to_regclass('housemate.expense_shares') IS NOT NULL AS shares`);
  if (status.rows[0]?.expenses && status.rows[0]?.shares) {
    console.log('Expense migration is already applied.');
  } else if (status.rows[0]?.expenses || status.rows[0]?.shares) {
    throw new Error('Expense migration is partially applied. Inspect the database before retrying.');
  } else {
    const sql = await readFile(new URL('../sql/003_shared_expenses.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('Expense migration applied.');
  }
} finally {
  await pool.end();
}
