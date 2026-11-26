import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/application.js';
import { PgMoneyRepository } from '../src/money.js';
import {
  calculateSettlementPreview,
  suggestSettlements,
} from '../src/money-calculation.js';
import type {
  MemberBalance,
  MoneyRepository,
  SettlementDraft,
} from '../src/money-types.js';
import type { HouseholdRepository } from '../src/types.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const carol = '00000000-0000-4000-8000-000000000003';
const home = '00000000-0000-4000-8000-000000000004';
const balances: MemberBalance[] = [
  {
    memberId: alice,
    displayName: 'Alice',
    status: 'active',
    netMinor: 150,
    owesMinor: 0,
    owedMinor: 150,
  },
  {
    memberId: bob,
    displayName: 'Bob',
    status: 'active',
    netMinor: -100,
    owesMinor: 100,
    owedMinor: 0,
  },
  {
    memberId: carol,
    displayName: 'Carol',
    status: 'active',
    netMinor: -50,
    owesMinor: 50,
    owedMinor: 0,
  },
];
const aliceBalance = balances[0];
if (!aliceBalance) throw new Error('Missing test member');
const draft: SettlementDraft = {
  senderMemberId: bob,
  recipientMemberId: alice,
  amountMinor: 60,
  currency: 'THB',
  settledOn: '2026-09-27',
  method: 'Cash',
  note: 'Paid at home',
};

test('suggestions are informational and deterministically clear balanced debts', () => {
  assert.deepEqual(
    suggestSettlements(balances).map((item) => [
      item.senderMemberId,
      item.recipientMemberId,
      item.amountMinor,
    ]),
    [
      [bob, alice, 100],
      [carol, alice, 50],
    ],
  );
  assert.deepEqual(
    suggestSettlements([
      { ...aliceBalance, status: 'removed' },
      ...balances.slice(1),
    ]),
    [],
  );
});

test('transfer preview and recording require the owner to be a participant', async () => {
  let actor = { memberId: bob, role: 'member' };
  const query = async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM housemate.households h'))
      return {
        rows: [
          {
            currency: 'THB',
            user_id: actor.memberId,
            member_id: actor.memberId,
            role: actor.role,
          },
        ],
      };
    if (sql.includes('WITH deltas AS'))
      return {
        rows: balances.map((member) => ({
          member_id: member.memberId,
          display_name: member.displayName,
          status: member.status,
          net_minor: String(member.netMinor),
        })),
      };
    if (sql.includes('pending_count'))
      return { rows: [{ pending_count: '0', pending_minor: '0' }] };
    throw new Error('Unexpected SQL');
  };
  const fakePool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  const repository = new PgMoneyRepository(fakePool);
  for (const denied of [
    { memberId: bob, role: 'member' },
    { memberId: bob, role: 'admin' },
    { memberId: carol, role: 'owner' },
  ]) {
    actor = denied;
    await assert.rejects(
      repository.previewSettlement(actor.memberId, home, draft),
      { statusCode: 403, code: 'FORBIDDEN' },
    );
    await assert.rejects(
      repository.createSettlement(actor.memberId, home, draft, home),
      { statusCode: 403, code: 'FORBIDDEN' },
    );
  }
  actor = { memberId: alice, role: 'owner' };
  assert.equal(
    (await repository.previewSettlement(alice, home, draft)).recipientMemberId,
    alice,
  );
});

test('manual transfer preview uses the documented signed ledger convention', () => {
  const preview = calculateSettlementPreview(draft, balances);
  assert.equal(preview.senderBeforeMinor, -100);
  assert.equal(preview.senderAfterMinor, -40);
  assert.equal(preview.receiverBeforeMinor, 150);
  assert.equal(preview.receiverAfterMinor, 90);
  assert.equal(preview.recommendedAmountMinor, 100);
  assert.deepEqual(preview.warnings, []);
  assert.match(
    calculateSettlementPreview({ ...draft, amountMinor: 101 }, balances)
      .warnings[0] ?? '',
    /exceeds/,
  );
});

test('settlement rejects invalid amounts, dates, same member, and inactive participants', () => {
  assert.throws(
    () => calculateSettlementPreview({ ...draft, amountMinor: 0 }, balances),
    /greater than zero/,
  );
  assert.throws(
    () =>
      calculateSettlementPreview(
        { ...draft, settledOn: '2026-02-30' },
        balances,
      ),
    /valid transfer date/,
  );
  assert.throws(
    () =>
      calculateSettlementPreview(
        { ...draft, recipientMemberId: bob },
        balances,
      ),
    /different/,
  );
  assert.throws(
    () =>
      calculateSettlementPreview(draft, [
        { ...aliceBalance, status: 'removed' },
        ...balances.slice(1),
      ]),
    /active/,
  );
});

test('money routes require a bearer token and pass identity to the repository', async () => {
  const seen: string[] = [];
  const money = {
    balances: async (userId: string, homeId: string) => {
      seen.push(`${userId}:${homeId}:balances`);
      return {
        householdId: homeId,
        currency: 'THB',
        viewerMemberId: bob,
        members: balances,
        suggestions: suggestSettlements(balances),
        pendingBillCount: 0,
        pendingBillAmountMinor: 0,
      };
    },
    previewSettlement: async (
      userId: string,
      homeId: string,
      input: SettlementDraft,
    ) => {
      seen.push(`${userId}:${homeId}:preview`);
      return calculateSettlementPreview(input, balances);
    },
  } as MoneyRepository;
  const app = createApp({
    auth: async (token) =>
      token === 'bob' ? { id: bob, email: null, displayName: 'Bob' } : null,
    households: {} as HouseholdRepository,
    money,
  });
  try {
    const balanceUrl = `/v1/households/${home}/balances`;
    const previewUrl = `/v1/households/${home}/settlements/preview`;
    assert.equal(
      (await app.inject({ method: 'GET', url: balanceUrl })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: previewUrl, payload: draft }))
        .statusCode,
      401,
    );
    const headers = { authorization: 'Bearer bob' };
    const response = await app.inject({
      method: 'GET',
      url: balanceUrl,
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().suggestions[0].amountMinor, 100);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: previewUrl,
          headers,
          payload: draft,
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(seen, [
      `${bob}:${home}:balances`,
      `${bob}:${home}:preview`,
    ]);
  } finally {
    await app.close();
  }
});
