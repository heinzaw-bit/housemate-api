import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { BillRepository } from '../src/bill-types.js';
import type { ExpenseRepository } from '../src/expense-types.js';
import type { HouseholdRepository } from '../src/types.js';
import {
  calculateVoidEffect,
  cleanVoidReason,
} from '../src/void-calculation.js';

const home = '00000000-0000-4000-8000-000000000001';
const expenseId = '00000000-0000-4000-8000-000000000002';
const billId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';
const previewId = '00000000-0000-4000-8000-000000000005';
const key = '00000000-0000-4000-8000-000000000006';

test('void routes require authentication, revision, preview, and retry key', async () => {
  const seen: string[] = [];
  const expenses = {
    previewVoid: async (
      user: string,
      household: string,
      record: string,
      revision: number,
      reason?: string,
    ) => {
      seen.push(
        `expense-preview:${user}:${household}:${record}:${revision}:${reason}`,
      );
      return { previewId };
    },
    void: async (
      user: string,
      household: string,
      record: string,
      revision: number,
      reason: string | undefined,
      token: string,
      retry: string,
    ) => {
      seen.push(
        `expense-void:${user}:${household}:${record}:${revision}:${reason}:${token}:${retry}`,
      );
      return { id: record };
    },
  } as ExpenseRepository;
  const bills = {
    previewVoid: async (
      user: string,
      household: string,
      record: string,
      revision: number,
      reason?: string,
    ) => {
      seen.push(
        `bill-preview:${user}:${household}:${record}:${revision}:${reason}`,
      );
      return { previewId };
    },
    void: async (
      user: string,
      household: string,
      record: string,
      revision: number,
      reason: string | undefined,
      token: string,
      retry: string,
    ) => {
      seen.push(
        `bill-void:${user}:${household}:${record}:${revision}:${reason}:${token}:${retry}`,
      );
      return { id: record };
    },
  } as BillRepository;
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
  const expenseUrl = `/v1/households/${home}/expenses/${expenseId}`;
  const billUrl = `/v1/households/${home}/bills/${billId}`;
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/void-preview`,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/void-preview`,
          headers,
          payload: { expectedRevision: 0 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/void`,
          headers,
          payload: { expectedRevision: 1, previewId },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/void-preview`,
          headers,
          payload: { expectedRevision: 1, reason: 'Duplicate' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/void`,
          headers,
          payload: {
            expectedRevision: 1,
            reason: 'Duplicate',
            previewId,
            idempotencyKey: key,
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${billUrl}/void-preview`,
          headers,
          payload: { expectedRevision: 3 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${billUrl}/void`,
          headers,
          payload: { expectedRevision: 3, previewId, idempotencyKey: key },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(seen, [
      `expense-preview:${userId}:${home}:${expenseId}:1:Duplicate`,
      `expense-void:${userId}:${home}:${expenseId}:1:Duplicate:${previewId}:${key}`,
      `bill-preview:${userId}:${home}:${billId}:3:undefined`,
      `bill-void:${userId}:${home}:${billId}:3:undefined:${previewId}:${key}`,
    ]);
  } finally {
    await app.close();
  }
});

test('void preview calculates exact member and pending effects', () => {
  const record = {
    id: expenseId,
    title: 'Groceries',
    amountMinor: 101,
    currency: 'THB' as const,
    payerMemberId: 'payer',
    shares: [
      { memberId: 'payer', amountMinor: 51 },
      { memberId: 'other', amountMinor: 50 },
    ],
  };
  const summary = {
    householdId: home,
    currency: 'THB' as const,
    viewerMemberId: 'payer',
    members: [
      {
        memberId: 'payer',
        displayName: 'Payer',
        status: 'active' as const,
        netMinor: 50,
        owesMinor: 0,
        owedMinor: 50,
      },
      {
        memberId: 'other',
        displayName: 'Other',
        status: 'active' as const,
        netMinor: -50,
        owesMinor: 50,
        owedMinor: 0,
      },
    ],
    suggestions: [],
    pendingBillCount: 1,
    pendingBillAmountMinor: 101,
  };
  const paid = calculateVoidEffect(record, summary, 1, null, true, false);
  assert.deepEqual(
    paid.balanceEffects.map((effect) => effect.afterMinor),
    [0, 0],
  );
  assert.equal(paid.pendingBillCountAfter, 1);
  const unpaid = calculateVoidEffect(record, summary, 1, null, false, true);
  assert.deepEqual(unpaid.balanceEffects, []);
  assert.equal(unpaid.pendingBillCountAfter, 0);
  assert.equal(unpaid.pendingBillAmountMinorAfter, 0);
  assert.equal(cleanVoidReason(' Duplicate '), 'Duplicate');
});
