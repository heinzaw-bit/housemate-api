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
     VALUES ('Financial edit transaction smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
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
        if (sql === 'BEGIN') return connection.query('SAVEPOINT edit_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT edit_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT edit_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const expenses = new PgExpenseRepository(transactionPool);
  const bills = new PgBillRepository(transactionPool);
  const money = new PgMoneyRepository(transactionPool);
  const ownerAuth = users.rows[0].auth_user_id;
  const memberAuth = users.rows[1].auth_user_id;
  const firstExpenseDraft = {
    title: 'Original expense', amountMinor: 100, currency: 'THB',
    spentOn: '2026-09-25', payerMemberId: memberIds[0],
    split: { method: 'equal', shares: memberIds.map((memberId) => ({ memberId })) },
  };
  const expense = await expenses.create(ownerAuth, householdId, firstExpenseDraft, randomUUID());
  assert.equal(expense.revision, 1);
  assert.equal(expense.canEdit, true);
  assert.equal((await expenses.get(memberAuth, householdId, expense.id)).canEdit, false);
  const changedExpense = { ...firstExpenseDraft, amountMinor: 200, payerMemberId: memberIds[1] };
  await assert.rejects(expenses.previewEdit(memberAuth, householdId, expense.id, changedExpense, 1),
    (error) => error.code === 'FORBIDDEN');
  const expensePreview = await expenses.previewEdit(ownerAuth, householdId, expense.id, changedExpense, 1);
  assert.deepEqual(expensePreview.shares.map((share) => share.amountMinor), [100, 100]);
  await assert.rejects(expenses.edit(ownerAuth, householdId, expense.id,
    { ...changedExpense, amountMinor: 201 }, 1, expensePreview.previewId, randomUUID()),
  (error) => error.code === 'PREVIEW_REQUIRED');
  const expenseKey = randomUUID();
  const editedExpense = await expenses.edit(ownerAuth, householdId, expense.id,
    changedExpense, 1, expensePreview.previewId, expenseKey);
  assert.equal(editedExpense.revision, 2);
  assert.equal(editedExpense.payerMemberId, memberIds[1]);
  assert.equal((await expenses.edit(ownerAuth, householdId, expense.id,
    changedExpense, 1, expensePreview.previewId, expenseKey)).revision, 2);
  await assert.rejects(expenses.previewEdit(ownerAuth, householdId, expense.id, changedExpense, 1),
    (error) => error.code === 'STALE_RECORD');
  await assert.rejects(expenses.edit(ownerAuth, householdId, expense.id,
    changedExpense, 1, expensePreview.previewId, randomUUID()),
  (error) => error.code === 'STALE_RECORD');
  assert.deepEqual((await money.balances(ownerAuth, householdId)).members
    .map((member) => member.netMinor).sort((a, b) => a - b), [-100, 100]);

  const originalBillDraft = {
    title: 'Original bill', billType: 'electricity', provider: 'Utility',
    amountMinor: 200, currency: 'THB', periodStart: '2026-08-01',
    periodEnd: '2026-08-31', dueDate: '2026-09-30',
    payerMemberId: memberIds[0], paymentStatus: 'unpaid',
    sharedParticipantIds: memberIds, adjustments: [],
  };
  const bill = await bills.create(memberAuth, householdId, originalBillDraft, randomUUID());
  assert.equal(bill.canEdit, false);
  assert.equal(bill.canVoid, false);
  assert.equal((await bills.get(ownerAuth, householdId, bill.id)).canEdit, true);
  const changedBill = {
    ...originalBillDraft,
    amountMinor: 300,
    payerMemberId: memberIds[1],
    adjustments: [{ label: 'Personal charge', kind: 'individual_charge', amountMinor: 100, memberIds: [memberIds[0]] }],
  };
  const forbidden = (error) => error.statusCode === 403 && error.code === 'FORBIDDEN';
  await assert.rejects(bills.previewEdit(memberAuth, householdId, bill.id, changedBill, 1), forbidden);
  await assert.rejects(bills.previewVoid(memberAuth, householdId, bill.id, 1), forbidden);
  await assert.rejects(bills.setStatus(memberAuth, householdId, bill.id, 'paid'), forbidden);
  const billPreview = await bills.previewEdit(ownerAuth, householdId, bill.id, changedBill, 1);
  await assert.rejects(bills.edit(memberAuth, householdId, bill.id, changedBill, 1,
    billPreview.previewId, randomUUID()), forbidden);
  const voidPreview = await bills.previewVoid(ownerAuth, householdId, bill.id, 1);
  await assert.rejects(bills.void(memberAuth, householdId, bill.id, 1, undefined,
    voidPreview.previewId, randomUUID()), forbidden);
  const billShareByMember = new Map(billPreview.shares.map((share) => [share.memberId, share.amountMinor]));
  assert.equal(billShareByMember.get(memberIds[0]), 200);
  assert.equal(billShareByMember.get(memberIds[1]), 100);
  const billKey = randomUUID();
  const editedBill = await bills.edit(ownerAuth, householdId, bill.id, changedBill, 1, billPreview.previewId, billKey);
  assert.equal(editedBill.revision, 2);
  assert.equal(editedBill.paymentStatus, 'unpaid');
  assert.equal((await bills.edit(ownerAuth, householdId, bill.id, changedBill, 1, billPreview.previewId, billKey)).revision, 2);
  assert.equal((await money.balances(ownerAuth, householdId)).pendingBillAmountMinor, 300);
  assert.deepEqual((await money.balances(ownerAuth, householdId)).members
    .map((member) => member.netMinor).sort((a, b) => a - b), [-100, 100]);
  const paid = await bills.setStatus(ownerAuth, householdId, bill.id, 'paid');
  assert.equal(paid.revision, 3);
  await assert.rejects(bills.setStatus(memberAuth, householdId, bill.id, 'unpaid'), forbidden);
  await assert.rejects(bills.previewEdit(ownerAuth, householdId, bill.id, changedBill, 2),
    (error) => error.code === 'STALE_RECORD');
  assert.deepEqual((await money.balances(ownerAuth, householdId)).members
    .map((member) => member.netMinor).sort((a, b) => a - b), [-300, 300]);
  const events = await connection.query(
    `SELECT resource_type, before_revision, after_revision, before_record, after_record
     FROM housemate.financial_edit_events WHERE household_id = $1 ORDER BY resource_type`,
    [householdId],
  );
  assert.deepEqual(events.rows.map((row) => row.resource_type), ['bill', 'expense']);
  assert.equal(events.rows[0].before_revision, 1);
  assert.equal(events.rows[0].after_revision, 2);
  assert.equal(events.rows[0].before_record.amountMinor, 200);
  assert.equal(events.rows[0].after_record.amountMinor, 300);
  const expenseHistory = await expenses.history(memberAuth, householdId, expense.id, 20, 0);
  assert.deepEqual(expenseHistory.events.map((event) => event.kind).sort(), ['created', 'edited']);
  const amountChange = expenseHistory.events.find((event) => event.kind === 'edited').changes.find((change) => change.field === 'amount');
  assert.equal(amountChange.before, '1.00 THB');
  assert.equal(amountChange.after, '2.00 THB');
  assert.equal(expenseHistory.events.find((event) => event.kind === 'created').changes.find((change) => change.field === 'amount').after, '1.00 THB');
  assert.equal((await expenses.history(ownerAuth, householdId, expense.id, 1, 0)).hasMore, true);
  assert.equal((await expenses.history(ownerAuth, householdId, expense.id, 1, 1)).events.length, 1);
  const billHistory = await bills.history(memberAuth, householdId, bill.id, 20, 0);
  assert.deepEqual(billHistory.events.map((event) => event.kind).sort(), ['created', 'edited', 'status_changed']);
  const statusChange = billHistory.events.find((event) => event.kind === 'status_changed');
  assert.equal(statusChange.changes[0].before, 'unpaid');
  assert.equal(statusChange.changes[0].after, 'paid');
  assert.equal(billHistory.events.find((event) => event.kind === 'created').changes.find((change) => change.field === 'paymentStatus').after, 'unpaid');

  // Promote the creator only within the temporary, rolled-back household.
  await connection.query(
    "UPDATE housemate.household_members SET role = 'admin' WHERE id = $1 AND household_id = $2",
    [memberIds[1], householdId],
  );
  const reopened = await bills.setStatus(memberAuth, householdId, bill.id, 'unpaid');
  assert.equal(reopened.paymentStatus, 'unpaid');
  assert.equal(reopened.canEdit, true);
  assert.equal(reopened.canVoid, true);
  const adminDraft = { ...changedBill, title: 'Admin correction' };
  const adminPreview = await bills.previewEdit(memberAuth, householdId, bill.id, adminDraft, reopened.revision);
  const adminKey = randomUUID();
  const edited = await bills.edit(memberAuth, householdId, bill.id, adminDraft,
    reopened.revision, adminPreview.previewId, adminKey);
  assert.equal(edited.title, adminDraft.title);
  const adminVoid = await bills.previewVoid(memberAuth, householdId, bill.id, edited.revision);
  assert.ok((await bills.void(memberAuth, householdId, bill.id, edited.revision, undefined,
    adminVoid.previewId, randomUUID())).voidedAt);
  await connection.query(
    "UPDATE housemate.household_members SET role = 'member' WHERE id = $1 AND household_id = $2",
    [memberIds[1], householdId],
  );
  await assert.rejects(bills.edit(memberAuth, householdId, bill.id, adminDraft,
    reopened.revision, adminPreview.previewId, adminKey), forbidden);
  console.log('Bill permissions for members, owners, and admins passed with the edit and balance checks. Rolling back test data.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
