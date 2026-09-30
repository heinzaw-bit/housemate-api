import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/application.js';
import { calculateShares } from '../src/expense-calculation.js';
import type { ExpenseDraft, ExpenseRepository } from '../src/expense-types.js';
import type { HouseholdRepository } from '../src/types.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const carol = '00000000-0000-4000-8000-000000000003';
const home = '00000000-0000-4000-8000-000000000004';
const members = new Map([
  [alice, 'Alice'],
  [bob, 'Bob'],
  [carol, 'Carol'],
]);

function draft(
  method: ExpenseDraft['split']['method'],
  shares: ExpenseDraft['split']['shares'],
  amountMinor = 101,
): ExpenseDraft {
  return {
    title: 'Groceries',
    amountMinor,
    currency: 'THB',
    spentOn: '2026-09-27',
    payerMemberId: alice,
    split: { method, shares },
  };
}

test('equal split distributes remainder deterministically among selected members', () => {
  const input = draft('equal', [{ memberId: bob }, { memberId: alice }]);
  assert.deepEqual(
    calculateShares(input, members).map((share) => share.amountMinor),
    [51, 50],
  );
  assert.deepEqual(
    calculateShares(
      {
        ...input,
        split: { method: 'equal', shares: [...input.split.shares].reverse() },
      },
      members,
    ).map((share) => share.amountMinor),
    [51, 50],
  );
});

test('exact, percentage, and ratio splits conserve minor units', () => {
  assert.deepEqual(
    calculateShares(
      draft('exact', [
        { memberId: alice, value: 20 },
        { memberId: bob, value: 81 },
      ]),
      members,
    ).map((share) => share.amountMinor),
    [20, 81],
  );
  assert.deepEqual(
    calculateShares(
      draft('percentage', [
        { memberId: alice, value: 5000 },
        { memberId: bob, value: 5000 },
      ]),
      members,
    ).map((share) => share.amountMinor),
    [51, 50],
  );
  assert.deepEqual(
    calculateShares(
      draft('ratio', [
        { memberId: alice, value: 2 },
        { memberId: bob, value: 1 },
      ]),
      members,
    ).map((share) => share.amountMinor),
    [67, 34],
  );
});

test('invalid totals, inactive participants, and malformed dates fail clearly', () => {
  assert.throws(
    () =>
      calculateShares(
        draft('exact', [{ memberId: alice, value: 100 }]),
        members,
      ),
    /add up/,
  );
  assert.throws(
    () =>
      calculateShares(
        draft('percentage', [{ memberId: alice, value: 9900 }]),
        members,
      ),
    /100%/,
  );
  assert.throws(
    () =>
      calculateShares(
        draft('equal', [{ memberId: '00000000-0000-4000-8000-000000000099' }]),
        members,
      ),
    /active/,
  );
  assert.throws(
    () =>
      calculateShares(
        { ...draft('equal', [{ memberId: alice }]), spentOn: '2026-02-30' },
        members,
      ),
    /valid expense date/,
  );
});

test('expense routes require authentication, validate input, and pass member identity to the service', async () => {
  const seen: string[] = [];
  const expenses = {
    preview: async (
      authUserId: string,
      householdId: string,
      input: ExpenseDraft,
    ) => {
      seen.push(`${authUserId}:${householdId}`);
      return {
        title: input.title,
        amountMinor: input.amountMinor,
        currency: input.currency,
        spentOn: input.spentOn,
        payerMemberId: input.payerMemberId,
        splitMethod: input.split.method,
        shares: calculateShares(input, members),
      };
    },
  } as ExpenseRepository;
  const app = createApp({
    auth: async (token) =>
      token === 'alice'
        ? { id: alice, displayName: 'Alice', email: null }
        : null,
    households: {} as HouseholdRepository,
    expenses,
  });
  try {
    const url = `/v1/households/${home}/expenses/preview`;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: draft('equal', [{ memberId: alice }]),
        })
      ).statusCode,
      401,
    );
    const headers = { authorization: 'Bearer alice' };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: draft('equal', [{ memberId: alice }]),
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(seen, [`${alice}:${home}`]);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            ...draft('equal', [{ memberId: alice }]),
            currency: 'EUR',
          },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
