import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBillRepository } from '../dist/bills.js';
import { PgDashboardRepository } from '../dist/dashboard.js';
import { PgExpenseRepository } from '../dist/expenses.js';
import { PgMoneyRepository } from '../dist/money.js';

// All fixtures and mutations are rolled back; existing household records are untouched.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  const users = (await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2')).rows;
  assert.equal(users.length, 2, 'Two existing members are required for this rollback-only check.');
  const transactionPool = {
    query: (...args) => connection.query(...args),
    connect: async () => ({
      query: (sql, params) => {
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT dashboard_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT dashboard_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT dashboard_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const dashboard = new PgDashboardRepository(transactionPool);
  const bills = new PgBillRepository(transactionPool);
  const expenses = new PgExpenseRepository(transactionPool);
  const money = new PgMoneyRepository(transactionPool);
  for (const currency of ['THB', 'USD']) {
    const householdId = (await connection.query(
      `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
       VALUES ('Dashboard transaction test', $1, 'Asia/Bangkok', $2) RETURNING id`, [currency, users[0].id],
    )).rows[0].id;
    const memberId = (await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', now()) RETURNING id`, [householdId, users[0].id],
    )).rows[0].id;
    const auth = users[0].auth_user_id;
    const empty = await dashboard.get(auth, householdId);
    assert.equal(empty.balance.currency, currency);
    assert.equal(empty.balance.pendingBillCount, 0);
    assert.deepEqual(empty.recentActivity, []);
    await assert.rejects(dashboard.get(users[1].auth_user_id, householdId), (error) => error.code === 'NOT_FOUND');
    await assert.rejects(dashboard.get(auth, randomUUID()), (error) => error.code === 'NOT_FOUND');
    const secondMember = (await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', 'active', now()) RETURNING id`, [householdId, users[1].id],
    )).rows[0].id;
    const dates = (await connection.query(`SELECT
      ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1)::text AS overdue,
      ((now() AT TIME ZONE 'Asia/Bangkok')::date + 7)::text AS soon,
      ((now() AT TIME ZONE 'Asia/Bangkok')::date + 8)::text AS later`)).rows[0];
    const draft = {
      title: 'Test due today', billType: 'water', provider: 'Test utility',
      amountMinor: 101, currency, periodStart: empty.today, periodEnd: empty.today,
      dueDate: empty.today, payerMemberId: memberId, paymentStatus: 'unpaid',
      sharedParticipantIds: [memberId, secondMember], adjustments: [],
    };
    const today = await bills.create(auth, householdId, draft, randomUUID());
    await bills.create(auth, householdId, { ...draft, title: 'Test overdue', dueDate: dates.overdue }, randomUUID());
    await bills.create(auth, householdId, { ...draft, title: 'Test seven days', dueDate: dates.soon }, randomUUID());
    await bills.create(auth, householdId, { ...draft, title: 'Test eight days', dueDate: dates.later }, randomUUID());
    const paid = await bills.create(auth, householdId, { ...draft, title: 'Test paid', paymentStatus: 'paid' }, randomUUID());
    const voided = await bills.create(auth, householdId, { ...draft, title: 'Test voided' }, randomUUID());
    const preview = await bills.previewVoid(auth, householdId, voided.id, 1);
    await bills.void(auth, householdId, voided.id, 1, undefined, preview.previewId, randomUUID());
    let result = await dashboard.get(auth, householdId);
    assert.equal(result.balance.pendingBillCount, 4);
    assert.equal(result.balance.pendingBillAmountMinor, 404);
    assert.equal(result.pendingBills.overdueCount, 1);
    assert.equal(result.pendingBills.dueSoonCount, 2);
    assert.deepEqual(result.pendingBills.items.map((b) => b.urgency), ['overdue', 'due_soon', 'due_soon', 'upcoming']);
    assert.ok(result.pendingBills.items.every((b) => b.id !== paid.id && b.id !== voided.id));
    assert.ok(result.recentActivity.some((event) => event.kind === 'voided'));
    assert.deepEqual(result.balance, await money.balances(auth, householdId));
    await bills.setStatus(auth, householdId, today.id, 'paid');
    result = await dashboard.get(auth, householdId);
    assert.equal(result.balance.pendingBillCount, 3);
    assert.ok(result.recentActivity.some((event) => event.kind === 'paid' && event.resourceId === today.id));
    const expenseDraft = { title: 'Dashboard expense', amountMinor: 200, currency, spentOn: empty.today,
      payerMemberId: memberId, split: { method: 'equal', shares: [{ memberId }, { memberId: secondMember }] } };
    const expense = await expenses.create(auth, householdId, expenseDraft, randomUUID());
    result = await dashboard.get(auth, householdId);
    assert.ok(result.recentActivity.some((event) => event.resourceType === 'expense' && event.resourceId === expense.id));
    assert.ok(result.balance.members.some((member) => member.netMinor !== 0));
    const updatedDraft = { ...expenseDraft, title: 'Edited dashboard expense', amountMinor: 300 };
    const editPreview = await expenses.previewEdit(auth, householdId, expense.id, updatedDraft, 1);
    await expenses.edit(auth, householdId, expense.id, updatedDraft, 1, editPreview.previewId, randomUUID());
    const settlement = await money.createSettlement(auth, householdId, {
      senderMemberId: secondMember, recipientMemberId: memberId, amountMinor: 50,
      currency, settledOn: empty.today,
    }, randomUUID());
    result = await dashboard.get(auth, householdId);
    assert.ok(result.recentActivity.some((event) => event.kind === 'edited' && event.resourceId === expense.id));
    assert.ok(result.recentActivity.some((event) => event.kind === 'recorded' && event.resourceId === settlement.id));
    assert.deepEqual(result.balance, await money.balances(auth, householdId));
    // Insert additional valid bills within this transaction to verify totals are not first-page totals.
    await connection.query(`INSERT INTO housemate.bills
      (household_id, title, bill_type, provider, amount_minor, currency, period_start, period_end,
       due_date, payer_member_id, payment_status, shared_participant_ids, adjustments,
       base_minor, charge_minor, credit_minor, created_by_user_id, idempotency_key, request_hash)
      SELECT household_id, 'Future test ' || n, bill_type, provider, amount_minor, currency,
       period_start, period_end, $2::date, payer_member_id, 'unpaid', shared_participant_ids,
       adjustments, base_minor, charge_minor, credit_minor, created_by_user_id, gen_random_uuid(), request_hash
      FROM housemate.bills CROSS JOIN generate_series(1, 52) n WHERE id = $1`, [today.id, dates.later]);
    result = await dashboard.get(auth, householdId);
    assert.equal(result.balance.pendingBillCount, 55);
    assert.equal(result.balance.pendingBillAmountMinor, 5555);
    assert.equal(result.pendingBills.items.length, 5);
    assert.equal(result.pendingBills.hasMore, true);
    assert.equal(result.pendingBills.items[0].urgency, 'overdue');
    assert.equal(result.recentActivity.length, 10);
    assert.deepEqual(result.recentActivity.map((event) => event.id), (await dashboard.get(auth, householdId)).recentActivity.map((event) => event.id));
    await connection.query(`UPDATE housemate.household_members SET status = 'removed' WHERE id = $1`, [memberId]);
    await assert.rejects(dashboard.get(auth, householdId), (error) => error.code === 'NOT_FOUND');
  }
  console.log('Dashboard smoke passed: USD/THB, timezone due boundaries, void/paid exclusions, exact totals beyond 50 bills, bounded activity, stable ordering, and household isolation. All fixtures rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
