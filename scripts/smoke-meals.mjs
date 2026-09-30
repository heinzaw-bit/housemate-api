import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgDashboardRepository } from '../dist/dashboard.js';
import { PgMealRepository } from '../dist/meals.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = (await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2')).rows;
  assert.equal(users.length, 2, 'Two existing members are required for the rollback-only check.');
  const transactionPool = {
    query: (...args) => connection.query(...args),
    connect: async () => ({
      query: (sql, params) => {
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT meal_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT meal_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT meal_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const meals = new PgMealRepository(transactionPool);
  const dashboard = new PgDashboardRepository(transactionPool);
  const householdId = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Meal transaction test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  const memberIds = [];
  for (const [index, user] of users.entries()) {
    const member = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    memberIds.push(member.rows[0].id);
  }
  const clock = (await connection.query(`SELECT
    to_char((now() + interval '2 days') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS meal,
    to_char((now() + interval '1 day') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS deadline`)).rows[0];
  const draft = { mealType: 'dinner', question: 'Join dinner?', startsAtLocal: clock.meal,
    responseDeadlineLocal: clock.deadline, participantIds: memberIds, cookingRoles: [{ memberId: memberIds[0], role: 'Cook' }],
    idempotencyKey: randomUUID() };
  const created = await meals.create(users[0].auth_user_id, householdId, draft);
  assert.equal(created.counts.awaiting, 2);
  assert.equal(created.cookingRoles[0].role, 'Cook');
  assert.equal((await meals.create(users[0].auth_user_id, householdId, draft)).id, created.id);
  await assert.rejects(meals.create(users[0].auth_user_id, householdId, { ...draft, question: 'Changed' }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await meals.list(users[1].auth_user_id, householdId, 'reply'))[0].id, created.id);
  assert.equal((await meals.list(users[1].auth_user_id, householdId, 'upcoming'))[0].id, created.id);
  assert.deepEqual(await meals.list(users[1].auth_user_id, householdId, 'upcoming', 1, 1), []);
  assert.deepEqual(await meals.list(users[1].auth_user_id, householdId, 'past'), []);
  const answered = await meals.respond(users[1].auth_user_id, householdId, created.id, 'joining');
  assert.equal(answered.counts.joining, 1);
  assert.equal(answered.counts.awaiting, 1);
  assert.deepEqual(await meals.list(users[1].auth_user_id, householdId, 'reply'), []);
  assert.equal((await meals.list(users[1].auth_user_id, householdId))[0].id, created.id);
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).nextMeal?.id, created.id);
  const revised = await meals.setRoles(users[1].auth_user_id, householdId, created.id,
    [{ memberId: memberIds[1], role: 'Main dish' }]);
  assert.equal(revised.cookingRoles[0].displayName.length > 0, true);
  assert.equal(revised.cookingRoles[0].role, 'Main dish');
  await assert.rejects(meals.setRoles(users[1].auth_user_id, householdId, created.id,
    [{ memberId: randomUUID(), role: 'Cook' }]), (error) => error.code === 'INVALID_ROLE');
  await assert.rejects(meals.list(users[0].auth_user_id, randomUUID()), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(meals.get(users[0].auth_user_id, randomUUID(), created.id), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(meals.get(randomUUID(), householdId, created.id), (error) => error.code === 'NOT_FOUND');
  await connection.query(`UPDATE housemate.meal_checks SET response_deadline = now() - interval '1 second' WHERE id = $1`, [created.id]);
  await assert.rejects(meals.respond(users[0].auth_user_id, householdId, created.id, 'maybe'),
    (error) => error.code === 'DEADLINE_PASSED');
  assert.equal((await meals.create(users[0].auth_user_id, householdId, draft)).id, created.id);
  console.log('Meal creation, retry, responses, roles, dashboard, deadline, and isolation passed; fixture rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
