import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgChoreRepository } from '../dist/chores.js';
import { PgDashboardRepository } from '../dist/dashboard.js';

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
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT chore_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT chore_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT chore_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const chores = new PgChoreRepository(transactionPool);
  const dashboard = new PgDashboardRepository(transactionPool);
  const householdId = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Chore transaction test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  const memberIds = [];
  for (const [index, user] of users.entries()) {
    const result = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
      [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    memberIds.push(result.rows[0].id);
  }
  const dueAtLocal = (await connection.query(
    `SELECT to_char((now() + interval '2 days') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS due`,
  )).rows[0].due;
  const draft = { title: 'Clean kitchen', note: 'Wipe the counter', dueAtLocal, assigneeMemberId: memberIds[1] };
  const created = await chores.create(users[0].auth_user_id, householdId, draft);
  assert.equal(created.status, 'open');
  assert.equal(created.assigneeMemberId, memberIds[1]);
  assert.equal(created.canComplete, true); // Owner may help.
  assert.equal((await chores.get(users[1].auth_user_id, householdId, created.id)).canRequestSwap, true);
  assert.equal((await chores.list(users[1].auth_user_id, householdId, 50, 0))[0].id, created.id);
  const overview = await dashboard.get(users[0].auth_user_id, householdId);
  assert.equal(overview.chores.openCount, 1);
  assert.equal(overview.chores.overdueCount, 0);
  assert.equal(overview.chores.nextDue.id, created.id);
  await connection.query(`UPDATE housemate.chores SET due_at = now() - interval '1 day' WHERE id = $1`, [created.id]);
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).chores.overdueCount, 1);
  await assert.rejects(chores.create(users[1].auth_user_id, householdId, { ...draft, assigneeMemberId: randomUUID() }),
    (error) => error.code === 'INVALID_ASSIGNEE');
  await assert.rejects(chores.list(users[1].auth_user_id, randomUUID(), 50, 0),
    (error) => error.code === 'NOT_FOUND');
  await assert.rejects(chores.get(users[1].auth_user_id, randomUUID(), created.id),
    (error) => error.code === 'NOT_FOUND');
  await assert.rejects(chores.get(randomUUID(), householdId, created.id),
    (error) => error.code === 'NOT_FOUND');
  await assert.rejects(chores.reassign(users[1].auth_user_id, householdId, created.id, memberIds[0], created.revision),
    (error) => error.code === 'FORBIDDEN');
  const requested = await chores.requestSwap(users[1].auth_user_id, householdId, created.id, memberIds[0], created.revision);
  assert.equal(requested.pendingSwap.targetMemberId, memberIds[0]);
  await assert.rejects(chores.requestSwap(users[1].auth_user_id, householdId, created.id, memberIds[0], created.revision),
    (error) => error.code === 'STALE_CHORE');
  await assert.rejects(chores.respondSwap(users[1].auth_user_id, householdId, created.id, requested.pendingSwap.id, 'accepted', requested.revision),
    (error) => error.code === 'FORBIDDEN');
  const declined = await chores.respondSwap(users[0].auth_user_id, householdId, created.id, requested.pendingSwap.id, 'declined', requested.revision);
  assert.equal(declined.assigneeMemberId, memberIds[1]);
  assert.equal(declined.pendingSwap, null);
  const requestedAgain = await chores.requestSwap(users[1].auth_user_id, householdId, created.id, memberIds[0], declined.revision);
  const accepted = await chores.respondSwap(users[0].auth_user_id, householdId, created.id, requestedAgain.pendingSwap.id, 'accepted', requestedAgain.revision);
  assert.equal(accepted.assigneeMemberId, memberIds[0]);
  await assert.rejects(chores.complete(users[1].auth_user_id, householdId, created.id, accepted.revision),
    (error) => error.code === 'FORBIDDEN');
  const reassigned = await chores.reassign(users[0].auth_user_id, householdId, created.id, memberIds[1], accepted.revision);
  const completed = await chores.complete(users[1].auth_user_id, householdId, created.id, reassigned.revision);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.closedByDisplayName.length > 0, true);
  await assert.rejects(chores.skip(users[1].auth_user_id, householdId, created.id, completed.revision, 'No time'),
    (error) => error.code === 'CHORE_CLOSED');
  const second = await chores.create(users[1].auth_user_id, householdId, { ...draft, title: 'Take out trash', assigneeMemberId: memberIds[0] });
  await assert.rejects(chores.complete(users[1].auth_user_id, householdId, second.id, second.revision),
    (error) => error.code === 'FORBIDDEN');
  const skipped = await chores.skip(users[0].auth_user_id, householdId, second.id, second.revision, '  Bin unavailable  ');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.skipReason, 'Bin unavailable');
  assert.equal((await chores.list(users[0].auth_user_id, householdId, 50, 0)).length, 2);
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).chores.openCount, 0);
  console.log('Chore assignment, completion, skip, swaps, revisions, permissions, and isolation passed; fixture rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
