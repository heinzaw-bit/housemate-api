import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgHouseActionRepository } from '../dist/house-actions.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = (
    await connection.query(
      'SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2',
    )
  ).rows;
  assert.equal(users.length, 2, 'Two existing users are required.');
  const transactionPool = {
    connect: async () => ({
      query: (sql, params) => {
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT actions_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT actions_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT actions_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const repository = new PgHouseActionRepository(transactionPool);
  const householdId = (
    await connection.query(
      `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
       VALUES ('House actions rollback check', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
      [users[0].id],
    )
  ).rows[0].id;
  const members = [];
  for (const [index, user] of users.entries()) {
    const result = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
      [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    members.push(result.rows[0].id);
  }
  const mealId = (
    await connection.query(
      `INSERT INTO housemate.meal_checks
       (household_id, meal_type, question, starts_at, response_deadline, timezone,
        created_by_user_id, idempotency_key, request_hash)
       VALUES ($1, 'dinner', 'Dinner?', now() + interval '2 days',
         now() + interval '1 day', 'Asia/Bangkok', $2, $3, $4) RETURNING id`,
      [householdId, users[0].id, randomUUID(), 'a'.repeat(64)],
    )
  ).rows[0].id;
  await connection.query(
    `INSERT INTO housemate.meal_participants (meal_id, member_id)
     VALUES ($1, $2)`,
    [mealId, members[1]],
  );
  const choreId = (
    await connection.query(
      `INSERT INTO housemate.chores
       (household_id, title, due_at, timezone, assignee_member_id, created_by_user_id)
       VALUES ($1, 'Clean kitchen', now() + interval '2 days', 'Asia/Bangkok', $2, $3)
       RETURNING id`,
      [householdId, members[1], users[0].id],
    )
  ).rows[0].id;
  await connection.query(
    `INSERT INTO housemate.chore_swap_requests
     (chore_id, requested_by_member_id, target_member_id)
     VALUES ($1, $2, $3)`,
    [choreId, members[1], members[0]],
  );
  const itemId = (
    await connection.query(
      `INSERT INTO housemate.shopping_items
       (household_id, title, priority, assigned_buyer_member_id, status, created_by_user_id, currency)
       VALUES ($1, 'Milk', 'high', $2, 'assigned', $3, 'THB') RETURNING id`,
      [householdId, members[1], users[0].id],
    )
  ).rows[0].id;

  const memberActions = await repository.get(users[1].auth_user_id, householdId);
  assert.deepEqual(memberActions.mealResponses.map((item) => item.id), [mealId]);
  assert.deepEqual(memberActions.chores.map((item) => item.id), [choreId]);
  assert.deepEqual(memberActions.shopping.map((item) => item.id), [itemId]);
  assert.deepEqual(memberActions.swapRequests, []);
  const ownerActions = await repository.get(users[0].auth_user_id, householdId);
  assert.deepEqual(ownerActions.swapRequests.map((item) => item.id), [choreId]);
  assert.deepEqual(ownerActions.mealResponses, []);
  await assert.rejects(
    repository.get(randomUUID(), householdId),
    (error) => error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    repository.get(users[0].auth_user_id, randomUUID()),
    (error) => error.code === 'NOT_FOUND',
  );

  await connection.query('UPDATE housemate.meal_participants SET response = $1, responded_at = now() WHERE meal_id = $2', ['joining', mealId]);
  await connection.query("UPDATE housemate.chores SET status = 'completed', closed_at = now(), closed_by_member_id = $1 WHERE id = $2", [members[1], choreId]);
  await connection.query("UPDATE housemate.chore_swap_requests SET status = 'cancelled', responded_at = now() WHERE chore_id = $1", [choreId]);
  await connection.query("UPDATE housemate.shopping_items SET status = 'purchased', purchased_at = now(), purchased_by_member_id = $1 WHERE id = $2", [members[1], itemId]);
  const cleared = await repository.get(users[1].auth_user_id, householdId);
  assert.deepEqual(cleared.mealResponses, []);
  assert.deepEqual(cleared.chores, []);
  assert.deepEqual(cleared.shopping, []);
  assert.deepEqual((await repository.get(users[0].auth_user_id, householdId)).swapRequests, []);
  console.log('Personal House actions, lifecycle, and isolation passed; fixture rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
