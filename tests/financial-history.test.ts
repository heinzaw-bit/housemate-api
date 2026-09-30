import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/application.js';
import type { BillRepository } from '../src/bill-types.js';
import type { Expense, ExpenseRepository } from '../src/expense-types.js';
import { historyChanges } from '../src/financial-history.js';
import type { HouseholdRepository } from '../src/types.js';

const householdId = '00000000-0000-4000-8000-000000000001';
const expenseId = '00000000-0000-4000-8000-000000000002';
const billId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';

test('financial history routes authenticate, validate pagination, and dispatch IDs', async () => {
  const seen: string[] = [];
  const expenses = {
    history: async (
      user: string,
      household: string,
      record: string,
      limit: number,
      offset: number,
    ) => {
      seen.push(`expense:${user}:${household}:${record}:${limit}:${offset}`);
      return { events: [], hasMore: false };
    },
  } as unknown as ExpenseRepository;
  const bills = {
    history: async (
      user: string,
      household: string,
      record: string,
      limit: number,
      offset: number,
    ) => {
      seen.push(`bill:${user}:${household}:${record}:${limit}:${offset}`);
      return { events: [], hasMore: false };
    },
  } as unknown as BillRepository;
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: userId, displayName: 'Member', email: null }
        : null,
    households: {} as HouseholdRepository,
    expenses,
    bills,
  });
  const headers = { authorization: 'Bearer member' };
  const expenseUrl = `/v1/households/${householdId}/expenses/${expenseId}/history`;
  const billUrl = `/v1/households/${householdId}/bills/${billId}/history`;
  try {
    assert.equal(
      (await app.inject({ method: 'GET', url: expenseUrl })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `${expenseUrl}?limit=51`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `${billUrl}?offset=-1`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: expenseUrl, headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `${billUrl}?limit=5&offset=10`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(seen, [
      `expense:${userId}:${householdId}:${expenseId}:20:0`,
      `bill:${userId}:${householdId}:${billId}:5:10`,
    ]);
  } finally {
    await app.close();
  }
});

test('history shows material values without mistaking a renamed member for a payer edit', () => {
  const before = {
    title: 'Groceries',
    amountMinor: 100,
    currency: 'THB',
    spentOn: '2026-09-27',
    payerMemberId: userId,
    payerDisplayName: 'Alice',
    splitMethod: 'equal',
    splitInput: {
      method: 'equal',
      shares: [{ memberId: userId }, { memberId: billId }],
    },
    shares: [
      { memberId: userId, displayName: 'Alice', amountMinor: 50 },
      { memberId: billId, displayName: 'Bob', amountMinor: 50 },
    ],
  } as Expense;
  const after = {
    ...before,
    amountMinor: 200,
    payerDisplayName: 'Alicia',
    shares: [
      { memberId: userId, displayName: 'Alicia', amountMinor: 100 },
      { memberId: billId, displayName: 'Bob', amountMinor: 100 },
    ],
  } as Expense;
  const changes = historyChanges('expense', before, after);
  assert.deepEqual(
    changes.map((change) => change.field),
    ['amount', 'shares'],
  );
  const amountChange = changes[0];
  assert.ok(amountChange);
  assert.equal(amountChange.before, '1.00 THB');
  assert.equal(amountChange.after, '2.00 THB');
});
