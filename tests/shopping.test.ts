import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import type { ShoppingItem, ShoppingRepository } from '../src/shopping.js';
import type { HouseholdRepository } from '../src/types.js';

test('shopping routes authenticate, validate, and scope every item action', async () => {
  const householdId = '00000000-0000-4000-8000-000000000001';
  const foreignId = '00000000-0000-4000-8000-000000000002';
  const itemId = '00000000-0000-4000-8000-000000000003';
  const memberId = '00000000-0000-4000-8000-000000000004';
  const key = '00000000-0000-4000-8000-000000000005';
  const item = {
    id: itemId,
    householdId,
    status: 'needed',
    revision: 1,
  } as ShoppingItem;
  const calls: string[] = [];
  const scope = (household: string) => {
    if (household !== householdId)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const shopping: ShoppingRepository = {
    list: async (_, household) => {
      scope(household);
      calls.push('list');
      return [item];
    },
    get: async (_, household, id) => {
      scope(household);
      calls.push('get');
      return id === itemId ? item : null;
    },
    create: async (_, household) => {
      scope(household);
      calls.push('create');
      return item;
    },
    edit: async (_, household) => {
      scope(household);
      calls.push('edit');
      return item;
    },
    cancel: async (_, household) => {
      scope(household);
      calls.push('cancel');
      return item;
    },
    purchase: async (_, household) => {
      scope(household);
      calls.push('purchase');
      return item;
    },
    purchaseWithExpense: async (_, household) => {
      scope(household);
      calls.push('expense');
      return { item, expense: { id: key } as never };
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'user', email: null, displayName: 'User' }
        : null,
    households: {} as HouseholdRepository,
    shopping,
  });
  const headers = { authorization: 'Bearer valid' };
  const root = `/v1/households/${householdId}/shopping-items`;
  const draft = {
    title: 'Eggs',
    quantity: 2,
    unit: 'packs',
    note: null,
    priority: 'normal',
    assignedBuyerMemberId: null,
    estimatedPriceMinor: 100,
  };
  const expenseDraft = {
    title: 'Shopping: Eggs',
    amountMinor: 120,
    currency: 'THB',
    spentOn: '2026-09-28',
    payerMemberId: memberId,
    split: { method: 'equal', shares: [{ memberId }] },
  };
  try {
    assert.equal((await app.inject(root)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: `/v1/households/${foreignId}/shopping-items`,
          headers,
        })
      ).statusCode,
      404,
    );
    const list = await app.inject({ url: root, headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(
      (await app.inject({ url: `${root}/${itemId}`, headers })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `${root}/bad`, headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: root, headers, payload: draft }))
        .statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: root,
          headers,
          payload: { ...draft, priority: 'invalid' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `${root}/${itemId}`,
          headers,
          payload: { ...draft, expectedRevision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${root}/${itemId}/cancel`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${root}/${itemId}/purchase`,
          headers,
          payload: { expectedRevision: 1, purchasedPriceMinor: 120 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${root}/${itemId}/purchase-with-expense`,
          headers,
          payload: { expectedRevision: 1, expenseDraft, idempotencyKey: key },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(calls, [
      'list',
      'get',
      'create',
      'edit',
      'cancel',
      'purchase',
      'expense',
    ]);
  } finally {
    await app.close();
  }
});
