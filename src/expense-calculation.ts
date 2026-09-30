import { ApiError } from './errors.js';
import type { ExpenseDraft, ExpenseShare } from './expense-types.js';

export const MAX_AMOUNT_MINOR = 999_999_999_999;

export function calculateShares(
  draft: ExpenseDraft,
  members: Map<string, string>,
): ExpenseShare[] {
  if (
    !Number.isSafeInteger(draft.amountMinor) ||
    draft.amountMinor < 1 ||
    draft.amountMinor > MAX_AMOUNT_MINOR
  )
    throw new ApiError(
      400,
      'INVALID_AMOUNT',
      'Enter an amount greater than zero and within the supported range.',
    );
  const spentOnTime = Date.parse(`${draft.spentOn}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(draft.spentOn) ||
    !Number.isFinite(spentOnTime) ||
    new Date(spentOnTime).toISOString().slice(0, 10) !== draft.spentOn
  )
    throw new ApiError(400, 'INVALID_DATE', 'Enter a valid expense date.');
  if (!draft.title.trim())
    throw new ApiError(400, 'VALIDATION_ERROR', 'Expense title is required.');
  if (!members.has(draft.payerMemberId))
    throw new ApiError(
      400,
      'INVALID_PAYER',
      'Choose an active household member as payer.',
    );
  const inputs = draft.split.shares;
  if (inputs.length < 1 || inputs.length > 100)
    throw new ApiError(
      400,
      'INVALID_PARTICIPANTS',
      'Choose at least one participant.',
    );
  const ids = inputs.map((item) => item.memberId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !members.has(id)))
    throw new ApiError(
      400,
      'INVALID_PARTICIPANTS',
      'Participants must be distinct active household members.',
    );
  const sorted = [...inputs].sort((a, b) =>
    a.memberId.localeCompare(b.memberId),
  );
  const amount = BigInt(draft.amountMinor);
  let allocations: Map<string, bigint>;
  if (draft.split.method === 'exact') {
    if (
      sorted.some(
        (item) => !Number.isSafeInteger(item.value) || (item.value ?? -1) < 0,
      )
    )
      throw new ApiError(
        400,
        'INVALID_SPLIT',
        'Enter valid exact amounts in minor units.',
      );
    const total = sorted.reduce(
      (sum, item) => sum + BigInt(item.value ?? 0),
      0n,
    );
    if (total !== amount)
      throw new ApiError(
        400,
        'SPLIT_TOTAL_MISMATCH',
        `Exact shares must add up to ${draft.amountMinor} minor units; they currently add up to ${total}.`,
      );
    allocations = new Map(
      sorted.map((item) => [item.memberId, BigInt(item.value ?? 0)]),
    );
  } else {
    let weights: bigint[];
    if (draft.split.method === 'equal') {
      weights = sorted.map(() => 1n);
    } else if (draft.split.method === 'percentage') {
      if (
        sorted.some(
          (item) =>
            !Number.isSafeInteger(item.value) ||
            (item.value ?? 0) < 0 ||
            (item.value ?? 0) > 10000,
        )
      )
        throw new ApiError(
          400,
          'INVALID_SPLIT',
          'Enter percentages from 0 to 100 with at most two decimals.',
        );
      const total = sorted.reduce((sum, item) => sum + (item.value ?? 0), 0);
      if (total !== 10000)
        throw new ApiError(
          400,
          'SPLIT_TOTAL_MISMATCH',
          `Percentages must add up to 100%; they currently add up to ${(total / 100).toFixed(2)}%.`,
        );
      weights = sorted.map((item) => BigInt(item.value ?? 0));
    } else if (draft.split.method === 'ratio') {
      if (
        sorted.some(
          (item) =>
            !Number.isSafeInteger(item.value) ||
            (item.value ?? 0) < 1 ||
            (item.value ?? 0) > 1000000,
        )
      )
        throw new ApiError(
          400,
          'INVALID_SPLIT',
          'Enter a positive whole-number ratio for each participant.',
        );
      weights = sorted.map((item) => BigInt(item.value ?? 0));
    } else {
      throw new ApiError(
        400,
        'INVALID_SPLIT',
        'Choose a supported split method.',
      );
    }
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
    const parts = sorted.map((item, index) => ({
      id: item.memberId,
      minor: (amount * (weights[index] ?? 0n)) / totalWeight,
      remainder: (amount * (weights[index] ?? 0n)) % totalWeight,
    }));
    let remaining = amount - parts.reduce((sum, part) => sum + part.minor, 0n);
    for (const part of [...parts].sort((a, b) =>
      a.remainder === b.remainder
        ? a.id.localeCompare(b.id)
        : a.remainder > b.remainder
          ? -1
          : 1,
    )) {
      if (remaining === 0n) break;
      part.minor += 1n;
      remaining -= 1n;
    }
    allocations = new Map(parts.map((part) => [part.id, part.minor]));
  }
  return sorted.map((item) => ({
    memberId: item.memberId,
    displayName: members.get(item.memberId) ?? '',
    amountMinor: Number(allocations.get(item.memberId) ?? 0n),
  }));
}
