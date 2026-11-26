import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';
import type { BalanceSummary } from './money-types.js';
import type { Currency } from './types.js';

export interface VoidBalanceEffect {
  memberId: string;
  displayName: string;
  beforeMinor: number;
  changeMinor: number;
  afterMinor: number;
}

export interface VoidPreview {
  recordId: string;
  title: string;
  amountMinor: number;
  currency: Currency;
  expectedRevision: number;
  reason: string | null;
  balanceEffects: VoidBalanceEffect[];
  expectedBalanceEffects?: VoidBalanceEffect[];
  pendingBillCountBefore: number;
  pendingBillCountAfter: number;
  pendingBillAmountMinorBefore: number;
  pendingBillAmountMinorAfter: number;
  previewId: string;
  expiresAt: string;
}

export interface VoidableRecord {
  id: string;
  title: string;
  amountMinor: number;
  currency: Currency;
  payerMemberId: string;
  shares: { memberId: string; amountMinor: number }[];
}

export function cleanVoidReason(value?: string): string | null {
  const reason = value?.trim() || null;
  if (reason && reason.length > 500)
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Keep the void reason under 500 characters.',
    );
  return reason;
}

export function voidRequestHash(revision: number, reason: string | null) {
  return createHash('sha256')
    .update(JSON.stringify({ action: 'void', revision, reason }))
    .digest('hex');
}

export function calculateVoidEffect(
  record: VoidableRecord,
  summary: BalanceSummary,
  expectedRevision: number,
  reason: string | null,
  includedInBalances: boolean,
  pendingBill: boolean,
): Omit<VoidPreview, 'previewId' | 'expiresAt'> {
  const changes = new Map<string, number>();
  if (includedInBalances || pendingBill) {
    changes.set(record.payerMemberId, -record.amountMinor);
    for (const share of record.shares)
      changes.set(
        share.memberId,
        (changes.get(share.memberId) ?? 0) + share.amountMinor,
      );
  }
  const balanceEffects = summary.members
    .map((member) => {
      const changeMinor = includedInBalances
        ? (changes.get(member.memberId) ?? 0)
        : 0;
      const afterMinor = member.netMinor + changeMinor;
      if (!Number.isSafeInteger(afterMinor))
        throw new Error('Voided balance exceeds supported range');
      return {
        memberId: member.memberId,
        displayName: member.displayName,
        beforeMinor: member.netMinor,
        changeMinor,
        afterMinor,
      };
    })
    .filter((effect) => effect.changeMinor !== 0);
  const expectedBalanceEffects = summary.members.every(
    (member) => member.expectedNetMinor !== undefined,
  )
    ? summary.members
        .map((member) => {
          const beforeMinor = member.expectedNetMinor ?? member.netMinor;
          const changeMinor = changes.get(member.memberId) ?? 0;
          const afterMinor = beforeMinor + changeMinor;
          if (!Number.isSafeInteger(afterMinor))
            throw new Error('Voided expected balance exceeds supported range');
          return {
            memberId: member.memberId,
            displayName: member.displayName,
            beforeMinor,
            changeMinor,
            afterMinor,
          };
        })
        .filter((effect) => effect.changeMinor !== 0)
    : undefined;
  return {
    recordId: record.id,
    title: record.title,
    amountMinor: record.amountMinor,
    currency: record.currency,
    expectedRevision,
    reason,
    balanceEffects,
    ...(expectedBalanceEffects === undefined ? {} : { expectedBalanceEffects }),
    pendingBillCountBefore: summary.pendingBillCount,
    pendingBillCountAfter: summary.pendingBillCount - (pendingBill ? 1 : 0),
    pendingBillAmountMinorBefore: summary.pendingBillAmountMinor,
    pendingBillAmountMinorAfter:
      summary.pendingBillAmountMinor - (pendingBill ? record.amountMinor : 0),
  };
}
