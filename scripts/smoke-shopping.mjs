import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgDashboardRepository } from '../dist/dashboard.js';
import { PgHouseholdRepository } from '../dist/households.js';
import { PgShoppingRepository } from '../dist/shopping.js';

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
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT shopping_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT shopping_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT shopping_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const shopping = new PgShoppingRepository(transactionPool);
  const dashboard = new PgDashboardRepository(transactionPool);
  const households = new PgHouseholdRepository(transactionPool);
  const householdId = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Shopping transaction test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  const members = [];
  for (const [index, user] of users.entries()) {
    const row = await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1,$2,$3,'active',now()) RETURNING id`, [householdId, user.id, index === 0 ? 'owner' : 'member'],
    );
    members.push(row.rows[0].id);
  }
  const draft = { title: 'Eggs', quantity: 2, unit: 'packs', note: 'Large', priority: 'high',
    assignedBuyerMemberId: null, estimatedPriceMinor: 120 };
  const first = await shopping.create(users[0].auth_user_id, householdId, draft);
  assert.equal(first.status, 'needed');
  assert.equal(first.currency, 'THB');
  assert.equal(first.quantity, 2);
  await assert.rejects(households.update(users[0].auth_user_id, householdId, { currency: 'USD' }),
    (error) => error.code === 'CURRENCY_LOCKED');
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).shoppingOpenCount, 1);
  const assigned = await shopping.edit(users[1].auth_user_id, householdId, first.id,
    { ...draft, assignedBuyerMemberId: members[1] }, first.revision);
  assert.equal(assigned.status, 'assigned');
  assert.equal(assigned.assignedBuyerMemberId, members[1]);
  await assert.rejects(shopping.edit(users[0].auth_user_id, householdId, first.id, draft, first.revision),
    (error) => error.code === 'STALE_ITEM');
  await assert.rejects(shopping.edit(users[0].auth_user_id, householdId, first.id,
    { ...draft, assignedBuyerMemberId: randomUUID() }, assigned.revision), (error) => error.code === 'INVALID_BUYER');
  const purchased = await shopping.purchase(users[0].auth_user_id, householdId, first.id, assigned.revision, 125);
  assert.equal(purchased.status, 'purchased');
  assert.equal(purchased.purchasedPriceMinor, 125);
  assert.equal(purchased.linkedExpenseId, null);
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).shoppingOpenCount, 0);
  await assert.rejects(shopping.cancel(users[0].auth_user_id, householdId, first.id, purchased.revision),
    (error) => error.code === 'ITEM_CLOSED');
  const cancelled = await shopping.create(users[0].auth_user_id, householdId, { ...draft, title: 'Bread' });
  assert.equal((await shopping.cancel(users[1].auth_user_id, householdId, cancelled.id, cancelled.revision)).status, 'cancelled');
  const toExpense = await shopping.create(users[0].auth_user_id, householdId, { ...draft, title: 'Rice' });
  const date = (await connection.query(`SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`)).rows[0].today;
  const expenseDraft = { title: 'Shopping: Rice', amountMinor: 101, currency: 'THB', spentOn: date,
    payerMemberId: members[1], split: { method: 'equal', shares: members.map((memberId) => ({ memberId })) } };
  await assert.rejects(shopping.purchaseWithExpense(users[1].auth_user_id, householdId, toExpense.id,
    toExpense.revision, { ...expenseDraft, payerMemberId: randomUUID() }, randomUUID()),
  (error) => error.code === 'INVALID_PAYER');
  assert.equal((await shopping.get(users[0].auth_user_id, householdId, toExpense.id)).status, 'needed');
  assert.equal((await connection.query('SELECT count(*)::integer AS count FROM housemate.expenses WHERE household_id = $1', [householdId])).rows[0].count, 0);
  const key = randomUUID();
  const linked = await shopping.purchaseWithExpense(users[1].auth_user_id, householdId, toExpense.id,
    toExpense.revision, expenseDraft, key);
  assert.equal(linked.item.status, 'purchased');
  assert.equal(linked.item.linkedExpenseId, linked.expense.id);
  assert.equal(linked.item.purchasedPriceMinor, 101);
  assert.equal((await shopping.purchaseWithExpense(users[1].auth_user_id, householdId, toExpense.id,
    toExpense.revision, expenseDraft, key)).expense.id, linked.expense.id);
  await assert.rejects(shopping.purchaseWithExpense(users[1].auth_user_id, householdId, toExpense.id,
    toExpense.revision, { ...expenseDraft, amountMinor: 102 }, key), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  const another = await shopping.create(users[0].auth_user_id, householdId,
    { ...draft, title: 'Rice', estimatedPriceMinor: null });
  await assert.rejects(shopping.purchaseWithExpense(users[1].auth_user_id, householdId, another.id,
    another.revision, expenseDraft, key), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await shopping.get(users[0].auth_user_id, householdId, another.id)).status, 'needed');
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).shoppingOpenCount, 1);
  assert.equal((await dashboard.get(users[0].auth_user_id, householdId)).balance.members.some((member) => member.netMinor !== 0), true);
  assert.equal((await shopping.list(users[0].auth_user_id, householdId, 50, 0)).length, 4);
  await assert.rejects(shopping.list(users[0].auth_user_id, randomUUID(), 50, 0), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(shopping.get(users[0].auth_user_id, randomUUID(), first.id), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(shopping.get(randomUUID(), householdId, first.id), (error) => error.code === 'NOT_FOUND');
  const flexibleHousehold = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('No-price shopping test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  await connection.query(
    `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
     VALUES ($1,$2,'owner','active',now())`, [flexibleHousehold, users[0].id],
  );
  const noPrice = await shopping.create(users[0].auth_user_id, flexibleHousehold,
    { ...draft, estimatedPriceMinor: null });
  assert.equal((await households.get(users[0].auth_user_id, flexibleHousehold)).currencyEditable, true);
  await households.update(users[0].auth_user_id, flexibleHousehold, { currency: 'USD' });
  const pricedInUsd = await shopping.edit(users[0].auth_user_id, flexibleHousehold, noPrice.id,
    { ...draft, estimatedPriceMinor: 150 }, noPrice.revision);
  assert.equal(pricedInUsd.currency, 'USD');
  await assert.rejects(households.update(users[0].auth_user_id, flexibleHousehold, { currency: 'THB' }),
    (error) => error.code === 'CURRENCY_LOCKED');
  console.log('Shopping add/edit/assign/cancel/purchase, atomic expense link, retry, balances, dashboard, and isolation passed; fixtures rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
