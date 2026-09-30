import { ApiError } from './errors.js';
import { MAX_AMOUNT_MINOR } from './expense-calculation.js';
import type {
  MemberBalance,
  SettlementDraft,
  SettlementPreview,
  SettlementSuggestion,
} from './money-types.js';

// Positive net means the household owes this member; negative means this member owes.
// Expenses and paid bills credit their payer and debit each participant's share.
// A recorded transfer credits its sender and debits its recipient.
export function suggestSettlements(
  members: MemberBalance[],
): SettlementSuggestion[] {
  const debtors = members
    .filter((member) => member.status === 'active' && member.netMinor < 0)
    .map((member) => ({ ...member, remaining: -member.netMinor }))
    .sort(
      (a, b) =>
        b.remaining - a.remaining || a.memberId.localeCompare(b.memberId),
    );
  const creditors = members
    .filter((member) => member.status === 'active' && member.netMinor > 0)
    .map((member) => ({ ...member, remaining: member.netMinor }))
    .sort(
      (a, b) =>
        b.remaining - a.remaining || a.memberId.localeCompare(b.memberId),
    );
  const result: SettlementSuggestion[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    if (!debtor || !creditor) break;
    const amountMinor = Math.min(debtor.remaining, creditor.remaining);
    if (amountMinor > 0)
      result.push({
        senderMemberId: debtor.memberId,
        senderDisplayName: debtor.displayName,
        recipientMemberId: creditor.memberId,
        recipientDisplayName: creditor.displayName,
        amountMinor,
      });
    debtor.remaining -= amountMinor;
    creditor.remaining -= amountMinor;
    if (debtor.remaining === 0) debtorIndex++;
    if (creditor.remaining === 0) creditorIndex++;
  }
  return result;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value
  );
}

export function calculateSettlementPreview(
  draft: SettlementDraft,
  members: MemberBalance[],
): SettlementPreview {
  if (
    !Number.isSafeInteger(draft.amountMinor) ||
    draft.amountMinor < 1 ||
    draft.amountMinor > MAX_AMOUNT_MINOR
  )
    throw new ApiError(
      400,
      'INVALID_AMOUNT',
      'Enter a transfer amount greater than zero and within the supported range.',
    );
  if (!validDate(draft.settledOn))
    throw new ApiError(400, 'INVALID_DATE', 'Enter a valid transfer date.');
  if (draft.senderMemberId === draft.recipientMemberId)
    throw new ApiError(
      400,
      'INVALID_SETTLEMENT',
      'Choose two different members.',
    );
  const sender = members.find(
    (member) =>
      member.memberId === draft.senderMemberId && member.status === 'active',
  );
  const recipient = members.find(
    (member) =>
      member.memberId === draft.recipientMemberId && member.status === 'active',
  );
  if (!sender || !recipient)
    throw new ApiError(
      400,
      'INVALID_SETTLEMENT',
      'Choose two active members from this household.',
    );
  const method = draft.method?.trim() || undefined;
  const note = draft.note?.trim() || undefined;
  if ((method?.length ?? 0) > 80 || (note?.length ?? 0) > 500)
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Keep the method under 80 characters and note under 500 characters.',
    );
  const recommendedAmountMinor = Math.min(
    Math.max(-sender.netMinor, 0),
    Math.max(recipient.netMinor, 0),
  );
  const warnings: string[] = [];
  if (recommendedAmountMinor === 0)
    warnings.push(
      'This transfer does not match a current debt between these members. Check the sender and recipient.',
    );
  else if (draft.amountMinor > recommendedAmountMinor)
    warnings.push(
      'This amount exceeds the current suggested transfer and may reverse a balance.',
    );
  return {
    ...draft,
    method,
    note,
    senderDisplayName: sender.displayName,
    recipientDisplayName: recipient.displayName,
    senderBeforeMinor: sender.netMinor,
    receiverBeforeMinor: recipient.netMinor,
    senderAfterMinor: sender.netMinor + draft.amountMinor,
    receiverAfterMinor: recipient.netMinor - draft.amountMinor,
    recommendedAmountMinor,
    warnings,
  };
}
