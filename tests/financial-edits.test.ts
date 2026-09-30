import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/application.js';
import type { BillDraft, BillRepository } from '../src/bill-types.js';
import type { ExpenseDraft, ExpenseRepository } from '../src/expense-types.js';
import type { HouseholdRepository } from '../src/types.js';

const home = '00000000-0000-4000-8000-000000000001';
const expenseId = '00000000-0000-4000-8000-000000000002';
const billId = '00000000-0000-4000-8000-000000000003';
const memberId = '00000000-0000-4000-8000-000000000004';
const previewId = '00000000-0000-4000-8000-000000000005';
const key = '00000000-0000-4000-8000-000000000006';
const expense: ExpenseDraft = {
  title: 'Rent correction',
  amountMinor: 10000,
  currency: 'THB',
  spentOn: '2026-09-27',
  payerMemberId: memberId,
  split: { method: 'equal', shares: [{ memberId }] },
};
const bill: BillDraft = {
  title: 'Electricity correction',
  billType: 'electricity',
  provider: 'Utility',
  amountMinor: 20000,
  currency: 'THB',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  dueDate: '2026-09-30',
  payerMemberId: memberId,
  paymentStatus: 'unpaid',
  sharedParticipantIds: [memberId],
  adjustments: [],
};

test('edit routes require auth, revision, preview ID, and dispatch the exact draft', async () => {
  const seen: string[] = [];
  const expenses = {
    previewEdit: async (
      userId: string,
      homeId: string,
      recordId: string,
      draft: ExpenseDraft,
      revision: number,
    ) => {
      seen.push(
        `expense-preview:${userId}:${homeId}:${recordId}:${revision}:${draft.amountMinor}`,
      );
      return { previewId };
    },
    edit: async (
      userId: string,
      homeId: string,
      recordId: string,
      draft: ExpenseDraft,
      revision: number,
      token: string,
      retry: string,
    ) => {
      seen.push(
        `expense-edit:${userId}:${homeId}:${recordId}:${revision}:${draft.amountMinor}:${token}:${retry}`,
      );
      return { id: recordId };
    },
  } as ExpenseRepository;
  const bills = {
    previewEdit: async (
      userId: string,
      homeId: string,
      recordId: string,
      draft: BillDraft,
      revision: number,
    ) => {
      seen.push(
        `bill-preview:${userId}:${homeId}:${recordId}:${revision}:${draft.amountMinor}`,
      );
      return { previewId };
    },
    edit: async (
      userId: string,
      homeId: string,
      recordId: string,
      draft: BillDraft,
      revision: number,
      token: string,
      retry: string,
    ) => {
      seen.push(
        `bill-edit:${userId}:${homeId}:${recordId}:${revision}:${draft.amountMinor}:${token}:${retry}`,
      );
      return { id: recordId };
    },
  } as BillRepository;
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: memberId, displayName: 'Member', email: null }
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
          url: `${expenseUrl}/edit-preview`,
          payload: { ...expense, expectedRevision: 1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: expenseUrl,
          headers,
          payload: { ...expense, expectedRevision: 1, idempotencyKey: key },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${expenseUrl}/edit-preview`,
          headers,
          payload: { ...expense, expectedRevision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: expenseUrl,
          headers,
          payload: {
            ...expense,
            expectedRevision: 1,
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
          url: `${billUrl}/edit-preview`,
          headers,
          payload: { ...bill, expectedRevision: 3 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: billUrl,
          headers,
          payload: {
            ...bill,
            expectedRevision: 3,
            previewId,
            idempotencyKey: key,
          },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(seen, [
      `expense-preview:${memberId}:${home}:${expenseId}:1:10000`,
      `expense-edit:${memberId}:${home}:${expenseId}:1:10000:${previewId}:${key}`,
      `bill-preview:${memberId}:${home}:${billId}:3:20000`,
      `bill-edit:${memberId}:${home}:${billId}:3:20000:${previewId}:${key}`,
    ]);
  } finally {
    await app.close();
  }
});
