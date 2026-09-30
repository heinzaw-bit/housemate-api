import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { calculateBill } from '../src/bill-calculation.js';
import type { BillDraft, BillRepository } from '../src/bill-types.js';
import type { HouseholdRepository } from '../src/types.js';

const ids = Array.from(
  { length: 9 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const names = ['Ethan', 'Henry', 'Donut', 'Johnny', 'Rio', 'A', 'B', 'C', 'D'];
const members = new Map(ids.map((id, index) => [id, names[index] ?? '']));
const householdId = '00000000-0000-4000-8000-000000000100';

function electricity(): BillDraft {
  return {
    title: 'Electricity',
    billType: 'electricity',
    provider: 'Utility',
    amountMinor: 210657,
    currency: 'THB',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    dueDate: '2026-09-15',
    payerMemberId: ids[0] ?? '',
    paymentStatus: 'unpaid',
    sharedParticipantIds: [...ids],
    adjustments: [
      {
        label: 'Ethan',
        kind: 'individual_charge',
        amountMinor: 500,
        memberIds: [ids[0] ?? ''],
      },
      {
        label: 'Henry',
        kind: 'individual_charge',
        amountMinor: 6000,
        memberIds: [ids[1] ?? ''],
      },
      {
        label: 'Donut',
        kind: 'individual_charge',
        amountMinor: 12500,
        memberIds: [ids[2] ?? ''],
      },
      {
        label: 'Johnny',
        kind: 'individual_charge',
        amountMinor: 18000,
        memberIds: [ids[3] ?? ''],
      },
      {
        label: 'Rio',
        kind: 'individual_charge',
        amountMinor: 2000,
        memberIds: [ids[4] ?? ''],
      },
      {
        label: 'Explicit shared adjustment',
        kind: 'shared_charge',
        amountMinor: 20400,
        memberIds: [...ids],
      },
    ],
  };
}

test('nine-member electricity preview allocates every minor unit exactly', () => {
  const preview = calculateBill(electricity(), members);
  assert.equal(preview.chargeMinor, 59400);
  assert.equal(preview.baseMinor, 151257);
  assert.equal(
    preview.shares.reduce((sum, share) => sum + share.baseMinor, 0),
    151257,
  );
  assert.equal(
    preview.shares.reduce((sum, share) => sum + share.amountMinor, 0),
    210657,
  );
  assert.deepEqual(
    preview.shares.map((share) => share.amountMinor),
    [19574, 25074, 31574, 37073, 21073, 19073, 19072, 19072, 19072],
  );
});

test('credits reduce named shares while the full bill still balances', () => {
  const input = electricity();
  input.amountMinor = 1000;
  input.adjustments = [
    {
      label: 'Rebate for Ethan',
      kind: 'individual_credit',
      amountMinor: 100,
      memberIds: [ids[0] ?? ''],
    },
  ];
  input.sharedParticipantIds = [ids[0] ?? '', ids[1] ?? ''];
  const firstAdjustment = input.adjustments[0];
  assert.ok(firstAdjustment);
  const preview = calculateBill(input, members);
  assert.equal(preview.baseMinor, 1100);
  assert.deepEqual(
    preview.shares.map((share) => share.amountMinor),
    [450, 550],
  );
  assert.throws(
    () =>
      calculateBill(
        {
          ...input,
          adjustments: [{ ...firstAdjustment, amountMinor: 2000 }],
        },
        members,
      ),
    /negative/,
  );
});

test('unclassified, unassigned, and over-reserved adjustments are rejected', () => {
  const input = electricity();
  const firstAdjustment = input.adjustments[0];
  assert.ok(firstAdjustment);
  assert.throws(
    () =>
      calculateBill(
        {
          ...input,
          adjustments: [
            {
              ...firstAdjustment,
              kind: '' as BillDraft['adjustments'][number]['kind'],
            },
          ],
        },
        members,
      ),
    /Choose what/,
  );
  assert.throws(
    () =>
      calculateBill(
        {
          ...input,
          adjustments: [{ ...firstAdjustment, memberIds: [] }],
        },
        members,
      ),
    /Assign each/,
  );
  assert.throws(
    () =>
      calculateBill(
        {
          ...input,
          adjustments: [{ ...firstAdjustment, amountMinor: 210658 }],
        },
        members,
      ),
    /exceed/,
  );
});

test('bill preview route requires authentication and validates ambiguous adjustments', async () => {
  const seen: string[] = [];
  const bills = {
    preview: async (userId: string, homeId: string, draft: BillDraft) => {
      seen.push(`${userId}:${homeId}`);
      return calculateBill(draft, members);
    },
  } as BillRepository;
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: ids[0] ?? '', displayName: 'Ethan', email: null }
        : null,
    households: {} as HouseholdRepository,
    bills,
  });
  try {
    const url = `/v1/households/${householdId}/bills/preview`;
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: electricity() }))
        .statusCode,
      401,
    );
    const headers = { authorization: 'Bearer member' };
    const good = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: electricity(),
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().baseMinor, 151257);
    assert.deepEqual(seen, [`${ids[0]}:${householdId}`]);
    const invalid = electricity();
    const ambiguous = invalid.adjustments[5];
    assert.ok(ambiguous);
    ambiguous.kind = '' as BillDraft['adjustments'][number]['kind'];
    assert.equal(
      (await app.inject({ method: 'POST', url, headers, payload: invalid }))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
