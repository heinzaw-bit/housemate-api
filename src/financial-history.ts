import type { Pool } from 'pg';
import type { Bill } from './bill-types.js';
import type { Expense } from './expense-types.js';

export interface FinancialHistoryChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface FinancialHistoryEvent {
  id: string;
  kind: 'created' | 'edited' | 'voided' | 'status_changed';
  occurredAt: string;
  actorDisplayName: string;
  changes: FinancialHistoryChange[];
}

export interface FinancialHistoryPage {
  events: FinancialHistoryEvent[];
  hasMore: boolean;
}

type Resource = 'expense' | 'bill';
type Snapshot = Expense | Bill;
type Description = {
  field: string;
  label: string;
  value: string;
  compareKey?: string;
};
interface EventRow {
  id: string;
  kind: FinancialHistoryEvent['kind'];
  occurred_at: Date;
  actor_display_name: string;
  before_record: Snapshot | null;
  after_record: Snapshot | null;
  old_status: 'paid' | 'unpaid' | null;
  new_status: 'paid' | 'unpaid' | null;
}

function money(amountMinor: number, currency: Snapshot['currency']) {
  const amount = BigInt(amountMinor);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toLocaleString('en-US');
  const cents = String(absolute % 100n).padStart(2, '0');
  return `${amount < 0n ? '-' : ''}${whole}.${cents} ${currency}`;
}

function memberNames(record: Snapshot) {
  return new Map(
    record.shares.map((share) => [share.memberId, share.displayName]),
  );
}

function describeExpense(record: Expense): Description[] {
  const names = memberNames(record);
  const splitRules = record.splitInput.shares
    .map(({ memberId, value }) => {
      const name = names.get(memberId) ?? memberId;
      if (record.splitInput.method === 'equal') return name;
      if (record.splitInput.method === 'exact')
        return `${name}: ${money(value ?? 0, record.currency)}`;
      if (record.splitInput.method === 'percentage')
        return `${name}: ${((value ?? 0) / 100).toFixed(2)}%`;
      return `${name}: ${value ?? 0} parts`;
    })
    .join('; ');
  return [
    { field: 'title', label: 'Title', value: record.title },
    {
      field: 'amount',
      label: 'Amount',
      value: money(record.amountMinor, record.currency),
      compareKey: `${record.amountMinor}:${record.currency}`,
    },
    { field: 'spentOn', label: 'Date', value: record.spentOn },
    {
      field: 'payer',
      label: 'Payer',
      value: record.payerDisplayName,
      compareKey: record.payerMemberId,
    },
    { field: 'splitMethod', label: 'Split method', value: record.splitMethod },
    {
      field: 'splitRules',
      label: 'Split inputs',
      value: splitRules,
      compareKey: JSON.stringify(
        [...record.splitInput.shares]
          .sort((a, b) => a.memberId.localeCompare(b.memberId))
          .map(({ memberId, value }) => [memberId, value ?? null]),
      ),
    },
    {
      field: 'shares',
      label: 'Final shares',
      value: record.shares
        .map(
          (share) =>
            `${share.displayName}: ${money(share.amountMinor, record.currency)}`,
        )
        .join('; '),
      compareKey: JSON.stringify(
        [...record.shares]
          .sort((a, b) => a.memberId.localeCompare(b.memberId))
          .map(({ memberId, amountMinor }) => [memberId, amountMinor]),
      ),
    },
  ];
}

function describeBill(record: Bill): Description[] {
  const names = memberNames(record);
  const adjustments = record.adjustments
    .map(
      (item) =>
        `${item.label} (${item.kind.replaceAll('_', ' ')}, ${money(item.amountMinor, record.currency)}): ${item.memberIds.map((id) => names.get(id) ?? id).join(', ')}`,
    )
    .join('; ');
  return [
    { field: 'title', label: 'Title', value: record.title },
    { field: 'type', label: 'Type', value: record.billType },
    { field: 'provider', label: 'Provider', value: record.provider },
    {
      field: 'amount',
      label: 'Amount',
      value: money(record.amountMinor, record.currency),
      compareKey: `${record.amountMinor}:${record.currency}`,
    },
    { field: 'periodStart', label: 'Period start', value: record.periodStart },
    { field: 'periodEnd', label: 'Period end', value: record.periodEnd },
    { field: 'dueDate', label: 'Due date', value: record.dueDate },
    {
      field: 'payer',
      label: 'Payer',
      value: record.payerDisplayName,
      compareKey: record.payerMemberId,
    },
    {
      field: 'paymentStatus',
      label: 'Provider status',
      value: record.paymentStatus,
    },
    {
      field: 'baseParticipants',
      label: 'Base participants',
      value: record.sharedParticipantIds
        .map((id) => names.get(id) ?? id)
        .join(', '),
      compareKey: JSON.stringify([...record.sharedParticipantIds].sort()),
    },
    {
      field: 'adjustments',
      label: 'Adjustments',
      value: adjustments || 'None',
      compareKey: JSON.stringify(
        record.adjustments.map((item) => ({
          label: item.label,
          kind: item.kind,
          amountMinor: item.amountMinor,
          memberIds: [...item.memberIds].sort(),
        })),
      ),
    },
    {
      field: 'base',
      label: 'Shared remainder',
      value: money(record.baseMinor, record.currency),
      compareKey: `${record.baseMinor}:${record.currency}`,
    },
    {
      field: 'shares',
      label: 'Final shares',
      value: record.shares
        .map(
          (share) =>
            `${share.displayName}: ${money(share.amountMinor, record.currency)}`,
        )
        .join('; '),
      compareKey: JSON.stringify(
        [...record.shares]
          .sort((a, b) => a.memberId.localeCompare(b.memberId))
          .map(({ memberId, amountMinor }) => [memberId, amountMinor]),
      ),
    },
  ];
}

export function historyChanges(
  resource: Resource,
  before: Snapshot | null,
  after: Snapshot,
): FinancialHistoryChange[] {
  const describe = (record: Snapshot) =>
    resource === 'expense'
      ? describeExpense(record as Expense)
      : describeBill(record as Bill);
  const old = before
    ? new Map(describe(before).map((item) => [item.field, item]))
    : new Map<string, Description>();
  return describe(after)
    .filter((item) => {
      const previous = old.get(item.field);
      return (
        (previous?.compareKey ?? previous?.value) !==
        (item.compareKey ?? item.value)
      );
    })
    .map((item) => ({
      field: item.field,
      label: item.label,
      before: old.get(item.field)?.value ?? null,
      after: item.value,
    }));
}

function eventFromRow(
  row: EventRow,
  resource: Resource,
  createdSnapshot: Snapshot,
): FinancialHistoryEvent {
  let changes: FinancialHistoryChange[];
  if (row.kind === 'created') {
    changes = historyChanges(resource, null, createdSnapshot);
  } else if (row.kind === 'status_changed') {
    changes = [
      {
        field: 'paymentStatus',
        label: 'Provider status',
        before: row.old_status,
        after: row.new_status,
      },
    ];
  } else if (row.kind === 'voided') {
    const prior = row.before_record as Bill | Expense;
    const after = row.after_record as Bill | Expense;
    changes = [
      {
        field: 'balanceTreatment',
        label:
          resource === 'bill' && (prior as Bill).paymentStatus === 'unpaid'
            ? 'Pending bill'
            : 'Balance treatment',
        before:
          resource === 'bill' && (prior as Bill).paymentStatus === 'unpaid'
            ? 'Included in pending bills'
            : 'Included in balances',
        after:
          resource === 'bill' && (prior as Bill).paymentStatus === 'unpaid'
            ? 'Removed from pending bills'
            : 'Excluded from balances',
      },
    ];
    if (after.voidReason)
      changes.push({
        field: 'reason',
        label: 'Reason',
        before: null,
        after: after.voidReason,
      });
  } else {
    changes = historyChanges(
      resource,
      row.before_record,
      row.after_record as Snapshot,
    );
  }
  return {
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    actorDisplayName: row.actor_display_name,
    changes,
  };
}

export async function readFinancialHistory(
  pool: Pool,
  resource: Resource,
  householdId: string,
  resourceId: string,
  current: Snapshot,
  limit: number,
  offset: number,
): Promise<FinancialHistoryPage> {
  const earliest = await pool.query<{ before_record: Snapshot }>(
    `SELECT before_record FROM housemate.financial_edit_events
     WHERE household_id = $1 AND resource_type = $2 AND resource_id = $3
     ORDER BY before_revision ASC LIMIT 1`,
    [householdId, resource, resourceId],
  );
  let createdSnapshot: Snapshot = earliest.rows[0]?.before_record ?? current;
  if (resource === 'bill') {
    const initialStatus = await pool.query<{
      new_status: Bill['paymentStatus'];
    }>(
      `SELECT se.new_status FROM housemate.bill_status_events se
       JOIN housemate.bills b ON b.id = se.bill_id
       WHERE b.household_id = $1 AND b.id = $2 AND se.old_status IS NULL
       ORDER BY se.changed_at ASC, se.id ASC LIMIT 1`,
      [householdId, resourceId],
    );
    if (initialStatus.rows[0])
      createdSnapshot = {
        ...createdSnapshot,
        paymentStatus: initialStatus.rows[0].new_status,
      } as Bill;
  }
  const table = resource === 'expense' ? 'expenses' : 'bills';
  const statusEvents =
    resource === 'bill'
      ? `UNION ALL
       SELECT se.id, 'status_changed'::text AS kind, se.changed_at AS occurred_at,
         actor.display_name AS actor_display_name, NULL::jsonb AS before_record,
         NULL::jsonb AS after_record, se.old_status, se.new_status
       FROM housemate.bill_status_events se
       JOIN housemate.bills b ON b.id = se.bill_id
       JOIN housemate.users actor ON actor.id = se.changed_by_user_id
       WHERE b.household_id = $1 AND b.id = $3 AND se.old_status IS NOT NULL`
      : '';
  const result = await pool.query<EventRow>(
    `WITH events AS (
       SELECT fe.id, CASE WHEN fe.action = 'void' THEN 'voided' ELSE 'edited' END AS kind,
         fe.changed_at AS occurred_at, actor.display_name AS actor_display_name,
         fe.before_record, fe.after_record, NULL::text AS old_status,
         NULL::text AS new_status
       FROM housemate.financial_edit_events fe
       JOIN housemate.users actor ON actor.id = fe.changed_by_user_id
       WHERE fe.household_id = $1 AND fe.resource_type = $2 AND fe.resource_id = $3
       ${statusEvents}
       UNION ALL
       SELECT r.id, 'created'::text AS kind, r.created_at AS occurred_at,
         creator.display_name AS actor_display_name, NULL::jsonb AS before_record,
         NULL::jsonb AS after_record, NULL::text AS old_status, NULL::text AS new_status
       FROM housemate.${table} r
       JOIN housemate.users creator ON creator.id = r.created_by_user_id
       WHERE r.household_id = $1 AND r.id = $3
     )
     SELECT * FROM events
     ORDER BY occurred_at DESC, CASE WHEN kind = 'created' THEN 0 ELSE 1 END DESC, id DESC
     LIMIT $4 OFFSET $5`,
    [householdId, resource, resourceId, limit + 1, offset],
  );
  return {
    events: result.rows
      .slice(0, limit)
      .map((row) => eventFromRow(row, resource, createdSnapshot)),
    hasMore: result.rows.length > limit,
  };
}
