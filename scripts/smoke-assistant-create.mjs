import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadConfig } from '../dist/config.js';
import { databasePoolOptions } from '../dist/database.js';
import { PgShoppingRepository } from '../dist/shopping.js';
import { PgChoreRepository } from '../dist/chores.js';
const pool = new pg.Pool({...databasePoolOptions(loadConfig()), max:1});
const client = await pool.connect();
const schema = `assistant_check_${randomUUID().replaceAll('-','')}`;
const replace = (sql) => sql.replaceAll('housemate.',`${schema}.`);
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(`CREATE SCHEMA ${schema}`);
  const tables=['users','households','household_members','expenses','shopping_items','chores','chore_swap_requests'];
  // Only empty isolated copies are mutated: no production household row/trigger is touched.
  await client.query(tables.map((table)=>`CREATE TABLE ${schema}.${table} (LIKE housemate.${table} INCLUDING ALL); ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY;`).join('\n'));
  const existing = await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('shopping_items','chores') AND column_name IN ('idempotency_key','request_hash')",[schema]);
  if(existing.rows[0].count===0) await client.query(replace(await readFile(new URL('../supabase/migrations/20261001180100_action_create_idempotency.sql',import.meta.url),'utf8')));
  else assert.equal(existing.rows[0].count,4);
  await client.query(`CREATE TABLE ${schema}.create_trace (kind text, record_id uuid); CREATE FUNCTION ${schema}.trace_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${schema}.create_trace VALUES (TG_TABLE_NAME,NEW.id); RETURN NEW; END $$; CREATE TRIGGER trace_shopping AFTER INSERT ON ${schema}.shopping_items FOR EACH ROW EXECUTE FUNCTION ${schema}.trace_create(); CREATE TRIGGER trace_chores AFTER INSERT ON ${schema}.chores FOR EACH ROW EXECUTE FUNCTION ${schema}.trace_create();`);
  const query = (sql,params)=>client.query(replace(sql),params);
  const transactionPool={query,connect:async()=>({query:(sql,params)=>sql.startsWith('BEGIN')?client.query('SAVEPOINT assistant_create'):sql==='COMMIT'?client.query('RELEASE SAVEPOINT assistant_create'):sql==='ROLLBACK'?client.query('ROLLBACK TO SAVEPOINT assistant_create'):query(sql,params),release:()=>{}})};
  const users=[];
  for(let i=0;i<2;i++) users.push((await query("INSERT INTO housemate.users (auth_user_id,display_name) VALUES ($1,$2) RETURNING id,auth_user_id",[randomUUID(),`Test member ${i}`])).rows[0]);
  const household=(await query("INSERT INTO housemate.households (name,default_currency,timezone,owner_user_id) VALUES ('Isolated assistant check','THB','Asia/Bangkok',$1) RETURNING id",[users[0].id])).rows[0].id;
  const members=[];
  for(let i=0;i<2;i++) members.push((await query("INSERT INTO housemate.household_members (household_id,user_id,role,status,joined_at) VALUES ($1,$2,$3,'active',now()) RETURNING id",[household,users[i].id,i?'member':'owner'])).rows[0].id);
  const shopping=new PgShoppingRepository(transactionPool);const chores=new PgChoreRepository(transactionPool);
  const item={title:'Eggs',quantity:2,unit:'packs',note:'Large',priority:'normal',assignedBuyerMemberId:members[1],estimatedPriceMinor:10001};
  const chore={title:'Clean kitchen',note:null,dueAtLocal:'2099-10-03T19:00',assigneeMemberId:members[1]};
  for(const [repository,draft,table] of [[shopping,item,'shopping_items'],[chores,chore,'chores']]) {
    const key=randomUUID();const first=await repository.create(users[0].auth_user_id,household,draft,key);
    assert.equal((await repository.create(users[0].auth_user_id,household,draft,key)).id,first.id);
    assert.equal((await query('SELECT count(*)::int AS count FROM housemate.create_trace WHERE record_id=$1',[first.id])).rows[0].count,1,'One creation side effect despite retry');
    await assert.rejects(repository.create(users[0].auth_user_id,household,{...draft,title:'Changed'},key),(cause)=>cause.code==='IDEMPOTENCY_CONFLICT');
    const other=await repository.create(users[1].auth_user_id,household,draft,key);assert.notEqual(other.id,first.id,'Keys are caller scoped');
    if(table==='shopping_items') await shopping.edit(users[0].auth_user_id,household,first.id,{...draft,title:'Updated eggs'},first.revision);
    else await chores.complete(users[1].auth_user_id,household,first.id,first.revision);
    const replay=await repository.create(users[0].auth_user_id,household,draft,key);assert.equal(replay.id,first.id);assert.equal(replay.revision,2,'Retry retains current state after later edits');
    assert.equal((await query(`SELECT count(*)::int AS count FROM housemate.${table} WHERE household_id=$1 AND created_by_user_id=$2 AND idempotency_key=$3`,[household,users[0].id,key])).rows[0].count,1);
    await assert.rejects(repository.create(users[0].auth_user_id,randomUUID(),draft,key),(cause)=>cause.code==='NOT_FOUND');
    await assert.rejects(repository.create(users[0].auth_user_id,household,draft,'invalid'),(cause)=>cause.code==='INVALID_IDEMPOTENCY_KEY');
    const legacy=await repository.create(users[0].auth_user_id,household,draft);assert.ok(legacy.id);
    const owner=(await query(`SELECT created_by_user_id,created_at,request_hash FROM housemate.${table} WHERE id=$1`,[first.id])).rows[0];assert.equal(owner.created_by_user_id,users[0].id);assert.match(owner.request_hash,/^[a-f0-9]{64}$/);assert.ok(owner.created_at);
  }
  await assert.rejects(shopping.create(users[0].auth_user_id,household,{...item,assignedBuyerMemberId:randomUUID()},randomUUID()),(cause)=>cause.code==='INVALID_BUYER');
  await assert.rejects(chores.create(users[0].auth_user_id,household,{...chore,assigneeMemberId:randomUUID()},randomUUID()),(cause)=>cause.code==='INVALID_ASSIGNEE');
  await assert.rejects(chores.create(users[0].auth_user_id,household,{...chore,dueAtLocal:'2020-01-01T10:00'},randomUUID()),(cause)=>cause.code==='INVALID_DUE_DATE');
  await query("UPDATE housemate.household_members SET status='left',left_at=now() WHERE id=$1",[members[1]]);
  await assert.rejects(chores.create(users[1].auth_user_id,household,chore,randomUUID()),(cause)=>cause.code==='NOT_FOUND');
  const protection=await client.query("SELECT bool_and(c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT') AND NOT has_table_privilege('authenticated',c.oid,'SELECT')) AS protected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='housemate' AND c.relname IN ('chores','shopping_items')");assert.equal(protection.rows[0].protected,true);
  console.log('Assistant create smoke passed: isolated migration, scoped retries/conflicts, one creation side effect, current state after edit, active-member validation and creator/time/hash trace. All scratch objects rolled back; production schema unchanged.');
} catch(cause) { console.error('Assistant creation smoke failed; sanitized code:',String(cause?.code??'assertion'));process.exitCode=1; }
finally { await client.query('ROLLBACK');client.release();await pool.end(); }
