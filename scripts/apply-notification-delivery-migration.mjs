import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {loadConfig} from '../dist/config.js';
import {databasePoolOptions} from '../dist/database.js';
const pool=new pg.Pool(databasePoolOptions(loadConfig()));
const client=await pool.connect();
try {
 await client.query('BEGIN');
 await client.query(await readFile(new URL('../sql/017_notification_delivery.sql',import.meta.url),'utf8'));
 await client.query('COMMIT');
 console.log('Notification delivery diagnostics migration ready; existing RLS retained.');
} catch { await client.query('ROLLBACK'); console.error('Migration failed; private database details withheld.'); process.exitCode=1; }
finally {client.release();await pool.end();}
