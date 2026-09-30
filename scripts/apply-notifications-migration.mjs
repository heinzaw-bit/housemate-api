import {readFile} from 'node:fs/promises';
import pg from 'pg';
if(!process.env.DATABASE_URL) throw Error('DATABASE_URL is required.');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
  const result=await pool.query("SELECT to_regclass('housemate.notifications') IS NOT NULL AS applied");
  if(result.rows[0].applied) console.log('Notifications migration already applied.');
  else {await pool.query(await readFile(new URL('../sql/014_notifications.sql',import.meta.url),'utf8'));console.log('Notifications migration applied.');}
  await pool.query(await readFile(new URL('../sql/015_notification_trigger_fix.sql',import.meta.url),'utf8'));
  console.log('Notification trigger correction applied.');
}finally{await pool.end();}
