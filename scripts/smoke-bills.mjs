import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBillRepository } from '../dist/bills.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2');
  assert.ok(users.rows[0], 'At least one signed-in HouseMate user is needed.');
  const household = await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Bill transaction smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
    [users.rows[0].id],
  );
  const householdId = household.rows[0].id;
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
        if (sql === 'BEGIN') return connection.query('SAVEPOINT bill_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT bill_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT bill_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const repository = new PgBillRepository(transactionPool);
  const draft = {
    title: 'Temporary electricity test', billType: 'electricity', provider: 'Utility',
    amountMinor: 10100, currency: 'THB', periodStart: '2026-08-01',
    periodEnd: '2026-08-31', dueDate: '2026-09-15', payerMemberId: memberIds[0],
    paymentStatus: 'unpaid', sharedParticipantIds: memberIds,
    adjustments: [
      { label: 'Personal charge', kind: 'individual_charge', amountMinor: 2000, memberIds: [memberIds[0]] },
      { label: 'Credit', kind: 'individual_credit', amountMinor: 1000, memberIds: [memberIds[0]] },
    ],
  };
  const userId = users.rows[0].auth_user_id;
  await assert.rejects(repository.preview(randomUUID(), householdId, draft),
    (error) => error.code === 'NOT_FOUND');
  const preview = await repository.preview(userId, householdId, draft);
  assert.equal(preview.baseMinor, 9100);
  assert.equal(preview.shares.reduce((sum, share) => sum + share.amountMinor, 0), 10100);
  const key = randomUUID();
  const first = await repository.create(userId, householdId, draft, key);
  const retry = await repository.create(userId, householdId, draft, key);
  assert.equal(first.id, retry.id);
  assert.deepEqual(first.shares.map((share) => share.amountMinor), preview.shares.map((share) => share.amountMinor));
  assert.equal((await repository.list(userId, householdId, 50, 0)).length, 1);
  assert.equal((await repository.get(userId, householdId, first.id))?.id, first.id);
  const paid = await repository.setStatus(userId, householdId, first.id, 'paid');
  assert.equal(paid.paymentStatus, 'paid');
  const history = await connection.query('SELECT count(*)::int AS total FROM housemate.bill_status_events WHERE bill_id = $1', [first.id]);
  assert.equal(history.rows[0].total, 2);
  const lock = await connection.query('SELECT currency_locked_at FROM housemate.households WHERE id = $1', [householdId]);
  assert.ok(lock.rows[0].currency_locked_at);
  await assert.rejects(repository.create(userId, householdId, { ...draft, title: 'Different' }, key),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  console.log('Bill preview, confirmation, retry, reads, status audit, and currency lock passed. Rolling back test data.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
