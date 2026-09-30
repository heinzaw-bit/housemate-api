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
     VALUES ('Financial void transaction smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
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
        if (sql === 'BEGIN') return connection.query('SAVEPOINT void_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT void_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT void_smoke');
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
  const expenseDraft = {
    title: 'Void test expense', amountMinor: 200, currency: 'THB',
    spentOn: '2026-09-27', payerMemberId: memberIds[0],
    split: { method: 'equal', shares: memberIds.map((memberId) => ({ memberId })) },
  };
  const expense = await expenses.create(ownerAuth, householdId, expenseDraft, randomUUID());
  const memberExpense = await expenses.get(memberAuth, householdId, expense.id);
  assert.equal(memberExpense.canEdit, false);
  assert.equal(memberExpense.canVoid, false);
  assert.equal((await money.balances(ownerAuth, householdId)).members.find((m) => m.memberId === memberIds[0]).netMinor, 100);
  await assert.rejects(expenses.previewVoid(memberAuth, householdId, expense.id, 1),
    (error) => error.code === 'FORBIDDEN');
  await assert.rejects(expenses.previewVoid(ownerAuth, householdId, randomUUID(), 1),
    (error) => error.code === 'NOT_FOUND');
  const preview = await expenses.previewVoid(ownerAuth, householdId, expense.id, 1, ' Duplicate ');
  await assert.rejects(expenses.void(memberAuth, householdId, expense.id, 1,
    'Duplicate', preview.previewId, randomUUID()), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(expenses.previewEdit(memberAuth, householdId, expense.id, expenseDraft, 1),
    (error) => error.code === 'FORBIDDEN');
  await assert.rejects(expenses.edit(memberAuth, householdId, expense.id, expenseDraft, 1,
    preview.previewId, randomUUID()), (error) => error.code === 'FORBIDDEN');
  assert.equal(preview.reason, 'Duplicate');
  assert.deepEqual(preview.balanceEffects.map((e) => e.changeMinor).sort((a, b) => a - b), [-100, 100]);
  await assert.rejects(expenses.void(ownerAuth, householdId, expense.id, 1,
    'Changed reason', preview.previewId, randomUUID()),
  (error) => error.code === 'PREVIEW_REQUIRED');
  const expenseKey = randomUUID();
  const voidedExpense = await expenses.void(ownerAuth, householdId, expense.id, 1,
    'Duplicate', preview.previewId, expenseKey);
  assert.equal(voidedExpense.revision, 2);
  assert.equal(voidedExpense.canEdit, false);
  assert.equal(voidedExpense.canVoid, false);
  assert.equal(voidedExpense.voidReason, 'Duplicate');
  assert.equal((await expenses.void(ownerAuth, householdId, expense.id, 1,
    'Duplicate', preview.previewId, expenseKey)).revision, 2);
  await assert.rejects(expenses.previewVoid(ownerAuth, householdId, expense.id, 2),
    (error) => error.code === 'ALREADY_VOIDED');
  await assert.rejects(expenses.previewEdit(ownerAuth, householdId, expense.id, expenseDraft, 2),
    (error) => error.code === 'ALREADY_VOIDED');
  assert.deepEqual((await money.balances(ownerAuth, householdId)).members.map((m) => m.netMinor), [0, 0]);
  assert.equal((await money.entries(ownerAuth, householdId, memberIds[0], 50, 0)).some((e) => e.sourceId === expense.id), false);

  const billDraft = {
    title: 'Void test bill', billType: 'electricity', provider: 'Utility',
    amountMinor: 300, currency: 'THB', periodStart: '2026-08-01',
    periodEnd: '2026-08-31', dueDate: '2026-09-30',
    payerMemberId: memberIds[0], paymentStatus: 'unpaid',
    sharedParticipantIds: memberIds, adjustments: [],
  };
  const bill = await bills.create(memberAuth, householdId, billDraft, randomUUID());
  const pendingPreview = await bills.previewVoid(ownerAuth, householdId, bill.id, 1);
  assert.deepEqual(pendingPreview.balanceEffects, []);
  assert.equal(pendingPreview.pendingBillAmountMinorBefore, 300);
  assert.equal(pendingPreview.pendingBillAmountMinorAfter, 0);
  await assert.rejects(bills.void(ownerAuth, householdId, bill.id, 2, undefined,
    pendingPreview.previewId, randomUUID()), (error) => error.code === 'STALE_RECORD');
  const voidedBill = await bills.void(ownerAuth, householdId, bill.id, 1, undefined,
    pendingPreview.previewId, randomUUID());
  assert.equal(voidedBill.voidedByDisplayName !== null, true);
  assert.equal((await money.balances(ownerAuth, householdId)).pendingBillAmountMinor, 0);
  await assert.rejects(bills.setStatus(ownerAuth, householdId, bill.id, 'paid'),
    (error) => error.code === 'ALREADY_VOIDED');

  const paid = await bills.create(ownerAuth, householdId,
    { ...billDraft, title: 'Paid bill', paymentStatus: 'paid' }, randomUUID());
  const memberBill = await bills.get(memberAuth, householdId, paid.id);
  assert.equal(memberBill.canEdit, false);
  assert.equal(memberBill.canVoid, false);
  const paidPreview = await bills.previewVoid(ownerAuth, householdId, paid.id, 1);
  await assert.rejects(bills.previewEdit(memberAuth, householdId, paid.id,
    { ...billDraft, title: 'Paid bill', paymentStatus: 'paid' }, 1),
  (error) => error.code === 'FORBIDDEN');
  await assert.rejects(bills.edit(memberAuth, householdId, paid.id,
    { ...billDraft, title: 'Paid bill', paymentStatus: 'paid' }, 1,
    paidPreview.previewId, randomUUID()), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(bills.previewVoid(memberAuth, householdId, paid.id, 1),
    (error) => error.code === 'FORBIDDEN');
  await assert.rejects(bills.void(memberAuth, householdId, paid.id, 1, undefined,
    paidPreview.previewId, randomUUID()), (error) => error.code === 'FORBIDDEN');
  assert.deepEqual(paidPreview.balanceEffects.map((e) => e.changeMinor).sort((a, b) => a - b), [-150, 150]);
  await bills.void(ownerAuth, householdId, paid.id, 1, undefined,
    paidPreview.previewId, randomUUID());
  assert.deepEqual((await money.balances(ownerAuth, householdId)).members.map((m) => m.netMinor), [0, 0]);
  const events = await connection.query(
    `SELECT action, before_revision, after_revision FROM housemate.financial_edit_events
     WHERE household_id = $1`, [householdId],
  );
  assert.equal(events.rows.length, 3);
  assert.ok(events.rows.every((event) => event.action === 'void' && event.after_revision === event.before_revision + 1));
  const expenseHistory = await expenses.history(memberAuth, householdId, expense.id, 20, 0);
  assert.deepEqual(expenseHistory.events.map((event) => event.kind).sort(), ['created', 'voided']);
  assert.equal(expenseHistory.events.find((event) => event.kind === 'voided').changes.find((change) => change.field === 'reason').after, 'Duplicate');
  const billHistory = await bills.history(ownerAuth, householdId, bill.id, 20, 0);
  assert.deepEqual(billHistory.events.map((event) => event.kind).sort(), ['created', 'voided']);
  assert.equal(billHistory.events.find((event) => event.kind === 'voided').changes[0].field, 'balanceTreatment');
  assert.equal(billHistory.events.find((event) => event.kind === 'voided').changes[0].after, 'Removed from pending bills');
  const foreignHousehold = await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Foreign void isolation smoke test', 'THB', 'Asia/Bangkok', $1) RETURNING id`,
    [users.rows[1].id],
  );
  const foreignId = foreignHousehold.rows[0].id;
  const foreignMember = await connection.query(
    `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'owner', 'active', now()) RETURNING id`,
    [foreignId, users.rows[1].id],
  );
  const foreignExpenseDraft = {
    ...expenseDraft,
    payerMemberId: foreignMember.rows[0].id,
    split: { method: 'equal', shares: [{ memberId: foreignMember.rows[0].id }] },
  };
  const foreignExpense = await expenses.create(memberAuth, foreignId, foreignExpenseDraft, randomUUID());
  const foreignBillDraft = {
    ...billDraft,
    payerMemberId: foreignMember.rows[0].id,
    sharedParticipantIds: [foreignMember.rows[0].id],
  };
  const foreignBill = await bills.create(memberAuth, foreignId, foreignBillDraft, randomUUID());
  assert.equal(await expenses.get(ownerAuth, householdId, foreignExpense.id), null);
  assert.equal(await bills.get(ownerAuth, householdId, foreignBill.id), null);
  for (const action of [
    () => expenses.history(ownerAuth, householdId, foreignExpense.id, 20, 0),
    () => expenses.previewEdit(ownerAuth, householdId, foreignExpense.id, expenseDraft, 1),
    () => expenses.edit(ownerAuth, householdId, foreignExpense.id, expenseDraft, 1, randomUUID(), randomUUID()),
    () => expenses.previewVoid(ownerAuth, householdId, foreignExpense.id, 1),
    () => expenses.void(ownerAuth, householdId, foreignExpense.id, 1, undefined, randomUUID(), randomUUID()),
    () => bills.history(ownerAuth, householdId, foreignBill.id, 20, 0),
    () => bills.previewEdit(ownerAuth, householdId, foreignBill.id, billDraft, 1),
    () => bills.edit(ownerAuth, householdId, foreignBill.id, billDraft, 1, randomUUID(), randomUUID()),
    () => bills.previewVoid(ownerAuth, householdId, foreignBill.id, 1),
    () => bills.void(ownerAuth, householdId, foreignBill.id, 1, undefined, randomUUID(), randomUUID()),
  ]) await assert.rejects(action(), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(expenses.history(ownerAuth, foreignId, foreignExpense.id, 20, 0),
    (error) => error.code === 'NOT_FOUND');
  await assert.rejects(bills.history(ownerAuth, foreignId, foreignBill.id, 20, 0),
    (error) => error.code === 'NOT_FOUND');
  console.log('Expense, unpaid bill, paid bill void previews, confirmation, balance removal, audit, permissions, and idempotency passed. Rolling back test data.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
