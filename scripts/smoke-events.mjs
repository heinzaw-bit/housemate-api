import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgEventRepository } from '../dist/events.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = (await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2')).rows;
  assert.equal(users.length, 2, 'Two existing users are required for the rollback-only check.');
  const transactionPool = {
    query: (...args) => connection.query(...args),
    connect: async () => ({
      query: (sql, params) => {
        if (sql === 'BEGIN') return connection.query('SAVEPOINT event_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT event_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT event_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const events = new PgEventRepository(transactionPool);
  const householdId = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Event transaction test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  const memberIds = [];
  for (const [index, user] of users.entries()) {
    const result = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1,$2,$3,'active',now()) RETURNING id`,
      [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    memberIds.push(result.rows[0].id);
  }
  const startsAtLocal = (await connection.query(
    `SELECT to_char((now() + interval '2 days') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS start`,
  )).rows[0].start;
  const endsAtLocal = (await connection.query(
    `SELECT to_char((now() + interval '2 days 2 hours') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS finish`,
  )).rows[0].finish;
  const draft = { title: 'House dinner', description: 'Bring a plate', location: 'Kitchen', startsAtLocal, endsAtLocal, idempotencyKey: randomUUID() };
  const created = await events.create(users[0].auth_user_id, householdId, draft);
  assert.equal(created.title, draft.title);
  assert.ok(new Date(created.endsAt) > new Date(created.startsAt));
  assert.equal(created.counts.awaiting, 2);
  assert.equal(created.canRespond, true);
  assert.equal((await events.create(users[0].auth_user_id, householdId, draft)).id, created.id);
  await assert.rejects(events.create(users[0].auth_user_id, householdId, { ...draft, title: 'Changed' }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(events.create(users[0].auth_user_id, householdId, { ...draft, endsAtLocal: startsAtLocal, idempotencyKey: randomUUID() }), (error) => error.code === 'INVALID_TIME');
  const replied = await events.respond(users[1].auth_user_id, householdId, created.id, 'going');
  assert.equal(replied.counts.going, 1);
  assert.equal(replied.attendees.find((person) => person.memberId === memberIds[1]).response, 'going');
  const changed = await events.respond(users[1].auth_user_id, householdId, created.id, 'maybe');
  assert.equal(changed.counts.going, 0);
  assert.equal(changed.counts.maybe, 1);
  assert.equal((await events.list(users[0].auth_user_id, householdId, 'upcoming', 50, 0))[0].id, created.id);
  assert.equal((await events.get(users[1].auth_user_id, householdId, created.id)).viewerMemberId, memberIds[1]);
  await assert.rejects(events.get(users[1].auth_user_id, randomUUID(), created.id), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(events.respond(users[1].auth_user_id, randomUUID(), created.id, 'going'), (error) => error.code === 'NOT_FOUND');
  await connection.query('UPDATE housemate.events SET starts_at = now() - interval \'1 minute\' WHERE id = $1', [created.id]);
  await assert.rejects(events.respond(users[1].auth_user_id, householdId, created.id, 'going'), (error) => error.code === 'EVENT_STARTED');
  assert.equal((await events.list(users[0].auth_user_id, householdId, 'past', 50, 0))[0].id, created.id);
  console.log('Event creation, idempotency, attendance changes, start lock, and household isolation passed; fixture rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
