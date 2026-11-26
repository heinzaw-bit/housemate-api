import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBillRepository } from '../dist/bills.js';
import { PgExpenseRepository } from '../dist/expenses.js';
import { PgMoneyRepository } from '../dist/money.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2');
  assert.equal(users.rows.length, 2, 'Two signed-in HouseMate users are needed for this smoke check.');
  const household = await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Settlement transaction smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
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
        if (sql === 'BEGIN') return connection.query('SAVEPOINT settlement_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT settlement_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT settlement_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const expenses = new PgExpenseRepository(transactionPool);
  const bills = new PgBillRepository(transactionPool);
  const money = new PgMoneyRepository(transactionPool);
  const aliceAuth = users.rows[0].auth_user_id;
  const bobAuth = users.rows[1].auth_user_id;
  await expenses.create(aliceAuth, householdId, {
    title: 'Temporary shared expense', amountMinor: 100, currency: 'THB',
    spentOn: '2026-09-26', payerMemberId: memberIds[0],
    split: { method: 'equal', shares: memberIds.map((memberId) => ({ memberId })) },
  }, randomUUID());
  const bill = await bills.create(aliceAuth, householdId, {
    title: 'Temporary bill', billType: 'electricity', provider: 'Utility',
    amountMinor: 200, currency: 'THB', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    dueDate: '2026-09-30', payerMemberId: memberIds[0], paymentStatus: 'unpaid',
    sharedParticipantIds: memberIds, adjustments: [],
  }, randomUUID());
  const before = await money.balances(aliceAuth, householdId);
  assert.deepEqual(before.members.map((member) => member.netMinor).sort((a, b) => a - b), [-50, 50]);
  assert.equal(before.pendingBillCount, 1);
  assert.equal(before.pendingBillAmountMinor, 200);
  assert.deepEqual(before.members.map((member) => member.pendingBillShareMinor), [100, 100]);
  assert.deepEqual(before.members.map((member) => member.expectedNetMinor).sort((a, b) => a - b), [-150, 150]);
  const otherViewer = await money.balances(bobAuth, householdId);
  assert.deepEqual(otherViewer.members, before.members, 'Every member sees the same pending allocations');
  assert.equal((await money.entries(bobAuth, householdId, memberIds[1], 50, 0)).length, 1);
  await bills.setStatus(aliceAuth, householdId, bill.id, 'paid');
  const paid = await money.balances(bobAuth, householdId);
  assert.deepEqual(paid.members.map((member) => member.netMinor).sort((a, b) => a - b), [-150, 150]);
  assert.equal(paid.pendingBillCount, 0);
  assert.ok(paid.members.every((member) => member.pendingBillShareMinor === 0));
  assert.deepEqual(paid.members.map((member) => member.expectedNetMinor), before.members.map((member) => member.expectedNetMinor), 'Paid confirms the same expected amounts without double counting');
  await bills.setStatus(aliceAuth, householdId, bill.id, 'unpaid');
  const unpaidAgain = await money.balances(bobAuth, householdId);
  assert.deepEqual(unpaidAgain.members.map((member) => member.netMinor).sort((a, b) => a - b), [-50, 50]);
  assert.deepEqual(unpaidAgain.members.map((member) => member.pendingBillShareMinor), [100, 100]);
  assert.deepEqual(unpaidAgain.members.map((member) => member.expectedNetMinor), before.members.map((member) => member.expectedNetMinor));
  await bills.setStatus(aliceAuth, householdId, bill.id, 'paid');
  assert.equal((await money.entries(bobAuth, householdId, memberIds[1], 50, 0)).length, 2);
  const draft = {
    senderMemberId: memberIds[1], recipientMemberId: memberIds[0],
    amountMinor: 75, currency: 'THB', settledOn: '2026-09-27',
    method: 'Cash', note: 'Temporary transaction test',
  };
  await assert.rejects(money.previewSettlement(randomUUID(), householdId, draft),
    (error) => error.code === 'NOT_FOUND');
  await assert.rejects(money.previewSettlement(bobAuth, householdId, draft),
    (error) => error.code === 'FORBIDDEN');
  const preview = await money.previewSettlement(aliceAuth, householdId, draft);
  assert.equal(preview.recommendedAmountMinor, 150);
  assert.equal(preview.senderAfterMinor, -75);
  assert.equal(preview.receiverAfterMinor, 75);
  const key = randomUUID();
  await assert.rejects(money.createSettlement(bobAuth, householdId, draft, key),
    (error) => error.code === 'FORBIDDEN');
  const first = await money.createSettlement(aliceAuth, householdId, draft, key);
  const retry = await money.createSettlement(aliceAuth, householdId, draft, key);
  assert.equal(first.id, retry.id);
  assert.equal(first.recordedByDisplayName.length > 0, true);
  assert.equal((await money.listSettlements(aliceAuth, householdId, 50, 0)).length, 1);
  assert.equal((await money.getSettlement(aliceAuth, householdId, first.id))?.id, first.id);
  const after = await money.balances(aliceAuth, householdId);
  assert.deepEqual(after.members.map((member) => member.netMinor).sort((a, b) => a - b), [-75, 75]);
  const bobEntries = await money.entries(bobAuth, householdId, memberIds[1], 50, 0);
  assert.equal(bobEntries.find((entry) => entry.sourceType === 'settlement')?.effectMinor, 75);
  assert.equal(bobEntries.reduce((sum, entry) => sum + entry.effectMinor, 0), -75);
  const planned = await bills.create(aliceAuth, householdId, {
    title: 'Planned payer outside the split', billType: 'internet', provider: 'Utility',
    amountMinor: 901, currency: 'THB', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    dueDate: '2026-09-30', payerMemberId: memberIds[0], paymentStatus: 'unpaid',
    sharedParticipantIds: [memberIds[1]], adjustments: [],
  }, randomUUID());
  const plannedBalances = await money.balances(bobAuth, householdId);
  const plannedPayer = plannedBalances.members.find((member) => member.memberId === memberIds[0]);
  const contributor = plannedBalances.members.find((member) => member.memberId === memberIds[1]);
  assert.equal(plannedPayer.pendingBillShareMinor, 0);
  assert.equal(plannedPayer.expectedNetMinor, 976, 'Credit the full bill to its planned payer even when they have no own share');
  assert.equal(contributor.expectedNetMinor, -976);
  assert.equal(plannedBalances.members.reduce((sum, member) => sum + member.expectedNetMinor, 0), 0);
  await bills.setStatus(aliceAuth, householdId, planned.id, 'paid');
  const confirmedPlanned = await money.balances(bobAuth, householdId);
  assert.deepEqual(confirmedPlanned.members.map((member) => member.expectedNetMinor), plannedBalances.members.map((member) => member.expectedNetMinor));
  const unpaidPlanned = await bills.setStatus(aliceAuth, householdId, planned.id, 'unpaid');
  const removal = await bills.previewVoid(aliceAuth, householdId, planned.id, unpaidPlanned.revision, 'Rollback-only preview check');
  assert.deepEqual(removal.balanceEffects, []);
  assert.deepEqual(removal.expectedBalanceEffects.map((effect) => effect.beforeMinor).sort((a, b) => a - b), [-976, 976]);
  assert.deepEqual(removal.expectedBalanceEffects.map((effect) => effect.afterMinor).sort((a, b) => a - b), [-75, 75]);
  await assert.rejects(money.createSettlement(aliceAuth, householdId, { ...draft, amountMinor: 76 }, key),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  console.log('Balances, pending/paid bills, ledger entries, suggestions, transfer preview, confirmation, and retry passed. Rolling back test data.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
