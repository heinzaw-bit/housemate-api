import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadConfig } from '../dist/config.js';
import { databasePoolOptions } from '../dist/database.js';

const pool = new pg.Pool(databasePoolOptions(loadConfig()));
try {
  const result = await pool.query("SELECT to_regclass('housemate.assistant_usage') IS NOT NULL AS applied");
  if (result.rows[0]?.applied) console.log('Assistant usage migration is already applied.');
  else {
    await pool.query(await readFile(new URL('../sql/016_assistant_usage.sql', import.meta.url), 'utf8'));
    console.log('Assistant usage migration applied.');
  }
} catch {
  console.error('Assistant migration failed. Check private database configuration; no connection details were printed.');
  process.exitCode = 1;
} finally { await pool.end(); }
