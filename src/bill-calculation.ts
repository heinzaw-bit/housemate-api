import type {
  BillAdjustmentPreview,
  BillDraft,
  BillPreview,
  BillShare,
} from './bill-types.js';
import { ApiError } from './errors.js';
import { MAX_AMOUNT_MINOR } from './expense-calculation.js';

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function allocate(amount: number, ids: string[]): Map<string, number> {
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  const each = Math.floor(amount / sorted.length);
  const extra = amount % sorted.length;
  return new Map(
    sorted.map((id, index) => [id, each + (index < extra ? 1 : 0)]),
  );
}

export function calculateBill(
  draft: BillDraft,
  members: Map<string, string>,
): BillPreview {
  if (
    !Number.isSafeInteger(draft.amountMinor) ||
    draft.amountMinor < 1 ||
    draft.amountMinor > MAX_AMOUNT_MINOR
  )
    throw new ApiError(
      400,
      'INVALID_AMOUNT',
      'Enter a bill amount greater than zero and within the supported range.',
    );
  if (!draft.title.trim() || !draft.provider.trim())
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Enter a bill title and provider.',
    );
  if (
    ![draft.periodStart, draft.periodEnd, draft.dueDate].every(validDate) ||
    draft.periodStart > draft.periodEnd
  )
    throw new ApiError(
      400,
      'INVALID_DATE',
      'Enter a valid billing period and due date.',
    );
  if (!members.has(draft.payerMemberId))
    throw new ApiError(
      400,
      'INVALID_PAYER',
      'Choose an active household member as payer.',
    );
  if (!['unpaid', 'paid'].includes(draft.paymentStatus))
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Choose a valid bill payment status.',
    );
  const participants = draft.sharedParticipantIds;
  if (
    !participants.length ||
    participants.length > 100 ||
    new Set(participants).size !== participants.length ||
    participants.some((id) => !members.has(id))
  )
    throw new ApiError(
      400,
      'INVALID_PARTICIPANTS',
      'Choose distinct active household members for the shared amount.',
    );
  if (draft.adjustments.length > 100)
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Use at most 100 adjustments per bill.',
    );

  let chargeMinor = 0;
  let creditMinor = 0;
  const adjustments: BillAdjustmentPreview[] = [];
  for (const item of draft.adjustments) {
    if (
      !item.label.trim() ||
      !Number.isSafeInteger(item.amountMinor) ||
      item.amountMinor < 1 ||
      item.amountMinor > MAX_AMOUNT_MINOR
    )
      throw new ApiError(
        400,
        'INVALID_ADJUSTMENT',
        'Each adjustment needs a label and a positive amount.',
      );
    if (
      ![
        'individual_charge',
        'shared_charge',
        'individual_credit',
        'shared_credit',
      ].includes(item.kind)
    )
      throw new ApiError(
        400,
        'AMBIGUOUS_ADJUSTMENT',
        'Choose what each adjustment means before previewing.',
      );
    if (
      !item.memberIds.length ||
      new Set(item.memberIds).size !== item.memberIds.length ||
      item.memberIds.some((id) => !members.has(id))
    )
      throw new ApiError(
        400,
        'INVALID_ADJUSTMENT',
        'Assign each adjustment to active household members.',
      );
    if (item.kind.startsWith('individual_') && item.memberIds.length !== 1)
      throw new ApiError(
        400,
        'INVALID_ADJUSTMENT',
        'An individual charge or credit must name one member.',
      );
    if (item.kind.endsWith('_charge')) chargeMinor += item.amountMinor;
    else creditMinor += item.amountMinor;
    const allocation = allocate(item.amountMinor, item.memberIds);
    adjustments.push({
      ...item,
      label: item.label.trim(),
      memberIds: [...item.memberIds].sort(),
      shares: [...allocation].map(([memberId, amountMinor]) => ({
        memberId,
        displayName: members.get(memberId) ?? '',
        amountMinor,
      })),
    });
  }
  const baseMinor = draft.amountMinor - chargeMinor + creditMinor;
  if (
    !Number.isSafeInteger(baseMinor) ||
    baseMinor < 0 ||
    baseMinor > MAX_AMOUNT_MINOR
  )
    throw new ApiError(
      400,
      'BILL_TOTAL_MISMATCH',
      'Assigned charges exceed the bill total, or credits make the shared remainder too large. Check the amounts.',
    );
  const base = allocate(baseMinor, participants);
  const totals = new Map<string, number>(
    [...members.keys()].map((id) => [id, base.get(id) ?? 0]),
  );
  const adjustmentsByMember = new Map<string, number>();
  for (const item of adjustments) {
    const sign = item.kind.endsWith('_credit') ? -1 : 1;
    for (const share of item.shares) {
      totals.set(
        share.memberId,
        (totals.get(share.memberId) ?? 0) + sign * share.amountMinor,
      );
      adjustmentsByMember.set(
        share.memberId,
        (adjustmentsByMember.get(share.memberId) ?? 0) +
          sign * share.amountMinor,
      );
    }
  }
  const shares: BillShare[] = [...totals]
    .filter(
      ([id, total]) =>
        total !== 0 || base.has(id) || adjustmentsByMember.has(id),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([memberId, amountMinor]) => ({
      memberId,
      displayName: members.get(memberId) ?? '',
      baseMinor: base.get(memberId) ?? 0,
      adjustmentMinor: adjustmentsByMember.get(memberId) ?? 0,
      amountMinor,
    }));
  if (shares.some((share) => share.amountMinor < 0))
    throw new ApiError(
      400,
      'CREDIT_EXCEEDS_SHARE',
      'A credit would make a member’s final share negative. Change the credit or its recipients.',
    );
  if (
    shares.reduce((sum, share) => sum + share.amountMinor, 0) !==
    draft.amountMinor
  )
    throw new Error('Bill allocation did not balance');
  return {
    ...draft,
    title: draft.title.trim(),
    provider: draft.provider.trim(),
    sharedParticipantIds: [...participants].sort(),
    adjustments: adjustments.map(({ shares: _shares, ...item }) => item),
    baseMinor,
    chargeMinor,
    creditMinor,
    shares,
    adjustmentBreakdown: adjustments,
  };
}
