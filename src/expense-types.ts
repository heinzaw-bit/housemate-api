import type { FinancialHistoryPage } from './financial-history.js';
import type { Currency } from './types.js';
import type { VoidPreview } from './void-calculation.js';

export type SplitMethod = 'equal' | 'exact' | 'percentage' | 'ratio';

export interface ExpenseSplitInput {
  method: SplitMethod;
  shares: { memberId: string; value?: number }[];
}

export interface ExpenseDraft {
  title: string;
  amountMinor: number;
  currency: Currency;
  spentOn: string;
  payerMemberId: string;
  split: ExpenseSplitInput;
}

export interface ExpenseShare {
  memberId: string;
  displayName: string;
  amountMinor: number;
}

export interface ExpensePreview extends Omit<ExpenseDraft, 'split'> {
  splitMethod: SplitMethod;
  shares: ExpenseShare[];
}

export interface Expense extends ExpensePreview {
  id: string;
  householdId: string;
  payerDisplayName: string;
  createdByDisplayName: string;
  createdAt: string;
  splitInput: ExpenseSplitInput;
  revision: number;
  updatedAt: string;
  canEdit: boolean;
  canVoid: boolean;
  voidedAt: string | null;
  voidedByDisplayName: string | null;
  voidReason: string | null;
}

export interface ExpenseEditPreview extends ExpensePreview {
  expectedRevision: number;
  previewId: string;
  expiresAt: string;
}

export interface ExpenseRepository {
  preview(
    authUserId: string,
    householdId: string,
    draft: ExpenseDraft,
  ): Promise<ExpensePreview>;
  create(
    authUserId: string,
    householdId: string,
    draft: ExpenseDraft,
    idempotencyKey: string,
  ): Promise<Expense>;
  list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Expense[]>;
  get(
    authUserId: string,
    householdId: string,
    expenseId: string,
  ): Promise<Expense | null>;
  previewEdit(
    authUserId: string,
    householdId: string,
    expenseId: string,
    draft: ExpenseDraft,
    expectedRevision: number,
  ): Promise<ExpenseEditPreview>;
  edit(
    authUserId: string,
    householdId: string,
    expenseId: string,
    draft: ExpenseDraft,
    expectedRevision: number,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Expense>;
  previewVoid(
    authUserId: string,
    householdId: string,
    expenseId: string,
    expectedRevision: number,
    reason?: string,
  ): Promise<VoidPreview>;
  void(
    authUserId: string,
    householdId: string,
    expenseId: string,
    expectedRevision: number,
    reason: string | undefined,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Expense>;
  history(
    authUserId: string,
    householdId: string,
    expenseId: string,
    limit: number,
    offset: number,
  ): Promise<FinancialHistoryPage>;
}
