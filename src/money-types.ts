import type { Currency } from './types.js';

export interface MemberBalance {
  memberId: string;
  displayName: string;
  status: 'active' | 'left' | 'removed' | 'invited';
  netMinor: number;
  owesMinor: number;
  owedMinor: number;
  expectedNetMinor?: number;
  pendingBillShareMinor?: number;
}

export interface SettlementSuggestion {
  senderMemberId: string;
  senderDisplayName: string;
  recipientMemberId: string;
  recipientDisplayName: string;
  amountMinor: number;
}

export interface BalanceSummary {
  householdId: string;
  currency: Currency;
  viewerMemberId: string;
  members: MemberBalance[];
  suggestions: SettlementSuggestion[];
  pendingBillCount: number;
  pendingBillAmountMinor: number;
}

export interface BalanceEntry {
  sourceType: 'expense' | 'bill' | 'settlement';
  sourceId: string;
  title: string;
  occurredOn: string;
  paidMinor: number;
  shareMinor: number;
  sentMinor: number;
  receivedMinor: number;
  effectMinor: number;
}

export interface SettlementDraft {
  senderMemberId: string;
  recipientMemberId: string;
  amountMinor: number;
  currency: Currency;
  settledOn: string;
  method?: string;
  note?: string;
}

export interface SettlementPreview extends SettlementDraft {
  senderDisplayName: string;
  recipientDisplayName: string;
  senderBeforeMinor: number;
  receiverBeforeMinor: number;
  senderAfterMinor: number;
  receiverAfterMinor: number;
  recommendedAmountMinor: number;
  warnings: string[];
}

export interface Settlement extends SettlementDraft {
  id: string;
  householdId: string;
  senderDisplayName: string;
  recipientDisplayName: string;
  recordedByDisplayName: string;
  createdAt: string;
}

export interface MoneyRepository {
  balances(authUserId: string, householdId: string): Promise<BalanceSummary>;
  entries(
    authUserId: string,
    householdId: string,
    memberId: string,
    limit: number,
    offset: number,
  ): Promise<BalanceEntry[]>;
  previewSettlement(
    authUserId: string,
    householdId: string,
    draft: SettlementDraft,
  ): Promise<SettlementPreview>;
  createSettlement(
    authUserId: string,
    householdId: string,
    draft: SettlementDraft,
    key: string,
  ): Promise<Settlement>;
  listSettlements(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Settlement[]>;
  getSettlement(
    authUserId: string,
    householdId: string,
    settlementId: string,
  ): Promise<Settlement | null>;
}
