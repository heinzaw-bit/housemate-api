import type { FinancialHistoryPage } from './financial-history.js';
import type { Currency } from './types.js';
import type { VoidPreview } from './void-calculation.js';

export type BillAdjustmentKind =
  | 'individual_charge'
  | 'shared_charge'
  | 'individual_credit'
  | 'shared_credit';
export type BillPaymentStatus = 'unpaid' | 'paid';

export interface BillAdjustmentInput {
  label: string;
  kind: BillAdjustmentKind;
  amountMinor: number;
  memberIds: string[];
}

export interface BillDraft {
  title: string;
  billType: 'electricity' | 'water' | 'internet' | 'rent' | 'other';
  provider: string;
  amountMinor: number;
  currency: Currency;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  payerMemberId: string;
  paymentStatus: BillPaymentStatus;
  sharedParticipantIds: string[];
  adjustments: BillAdjustmentInput[];
}

export interface BillShare {
  memberId: string;
  displayName: string;
  baseMinor: number;
  adjustmentMinor: number;
  amountMinor: number;
}

export interface BillAdjustmentPreview extends BillAdjustmentInput {
  shares: { memberId: string; displayName: string; amountMinor: number }[];
}

export interface BillPreview extends BillDraft {
  baseMinor: number;
  chargeMinor: number;
  creditMinor: number;
  shares: BillShare[];
  adjustmentBreakdown: BillAdjustmentPreview[];
}

export interface Bill extends BillPreview {
  id: string;
  householdId: string;
  payerDisplayName: string;
  createdByDisplayName: string;
  createdAt: string;
  statusUpdatedAt: string;
  revision: number;
  updatedAt: string;
  canEdit: boolean;
  canVoid: boolean;
  voidedAt: string | null;
  voidedByDisplayName: string | null;
  voidReason: string | null;
}

export interface BillEditPreview extends BillPreview {
  expectedRevision: number;
  previewId: string;
  expiresAt: string;
}

export interface BillRepository {
  preview(
    authUserId: string,
    householdId: string,
    draft: BillDraft,
  ): Promise<BillPreview>;
  create(
    authUserId: string,
    householdId: string,
    draft: BillDraft,
    key: string,
  ): Promise<Bill>;
  list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Bill[]>;
  get(
    authUserId: string,
    householdId: string,
    billId: string,
  ): Promise<Bill | null>;
  setStatus(
    authUserId: string,
    householdId: string,
    billId: string,
    status: BillPaymentStatus,
  ): Promise<Bill>;
  previewEdit(
    authUserId: string,
    householdId: string,
    billId: string,
    draft: BillDraft,
    expectedRevision: number,
  ): Promise<BillEditPreview>;
  edit(
    authUserId: string,
    householdId: string,
    billId: string,
    draft: BillDraft,
    expectedRevision: number,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Bill>;
  previewVoid(
    authUserId: string,
    householdId: string,
    billId: string,
    expectedRevision: number,
    reason?: string,
  ): Promise<VoidPreview>;
  void(
    authUserId: string,
    householdId: string,
    billId: string,
    expectedRevision: number,
    reason: string | undefined,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Bill>;
  history(
    authUserId: string,
    householdId: string,
    billId: string,
    limit: number,
    offset: number,
  ): Promise<FinancialHistoryPage>;
}
