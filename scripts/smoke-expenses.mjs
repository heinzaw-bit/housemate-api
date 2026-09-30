import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgExpenseRepository } from '../dist/expenses.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
let householdId;
try {
  await connection.query('BEGIN');
  const users = await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2');
  assert.ok(users.rows[0], 'At least one signed-in HouseMate user is needed.');
  const household = await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Expense transaction smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
    [users.rows[0].id],
  );
  householdId = household.rows[0].id;
  const memberIds = [];
  for (const [index, user] of users.rows.entries()) {
    const member = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
      [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    memberIds.push(member.rows[0].id);
  }
  const transactionPool = {
    query: (...args) => connection.query(...args),
    connect: async () => ({
      query: (sql, params) => {
        if (sql === 'BEGIN') return connection.query('SAVEPOINT expense_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT expense_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT expense_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const repository = new PgExpenseRepository(transactionPool);
  const draft = {
    title: 'Temporary smoke test', amountMinor: 101, currency: 'THB',
    spentOn: '2026-09-27', payerMemberId: memberIds[0],
    split: { method: 'equal', shares: memberIds.map((memberId) => ({ memberId })) },
  };
  const userId = users.rows[0].auth_user_id;
  const preview = await repository.preview(userId, householdId, draft);
  assert.equal(preview.shares.reduce((sum, share) => sum + share.amountMinor, 0), 101);
  const key = randomUUID();
  const first = await repository.create(userId, householdId, draft, key);
  const retry = await repository.create(userId, householdId, draft, key);
  assert.equal(first.id, retry.id);
  assert.equal((await repository.list(userId, householdId, 50, 0)).length, 1);
  assert.equal((await repository.get(userId, householdId, first.id))?.id, first.id);
  const lock = await connection.query('SELECT currency_locked_at FROM housemate.households WHERE id = $1', [householdId]);
  assert.ok(lock.rows[0].currency_locked_at);
  await assert.rejects(repository.create(userId, householdId, { ...draft, title: 'Different' }, key),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  console.log('Expense preview, confirmation, reads, currency lock, and retry passed. Rolling back test data.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
