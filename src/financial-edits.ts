import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BillDraft } from './bill-types.js';
import { ApiError } from './errors.js';
import type { ExpenseDraft } from './expense-types.js';

type Db = Pool | PoolClient;
export type FinancialResource = 'expense' | 'bill';

export function canonicalExpense(draft: ExpenseDraft): ExpenseDraft {
  return {
    title: draft.title.trim(),
    amountMinor: draft.amountMinor,
    currency: draft.currency,
    spentOn: draft.spentOn,
    payerMemberId: draft.payerMemberId,
    split: {
      method: draft.split.method,
      shares: [...draft.split.shares].sort((a, b) =>
        a.memberId.localeCompare(b.memberId),
      ),
    },
  };
}

export function canonicalBill(draft: BillDraft): BillDraft {
  return {
    title: draft.title.trim(),
    billType: draft.billType,
    provider: draft.provider.trim(),
    amountMinor: draft.amountMinor,
    currency: draft.currency,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    dueDate: draft.dueDate,
    payerMemberId: draft.payerMemberId,
    paymentStatus: draft.paymentStatus,
    sharedParticipantIds: [...draft.sharedParticipantIds].sort(),
    adjustments: draft.adjustments.map((item) => ({
      ...item,
      label: item.label.trim(),
      memberIds: [...item.memberIds].sort(),
    })),
  };
}

export function editRequestHash(
  draft: ExpenseDraft | BillDraft,
  revision: number,
) {
  return createHash('sha256')
    .update(JSON.stringify({ revision, draft }))
    .digest('hex');
}

export function requireEditPermission(
  userId: string,
  role: string,
  createdByUserId: string,
  action: 'edit' | 'void' = 'edit',
) {
  if (userId !== createdByUserId && role !== 'owner' && role !== 'admin')
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the creator or a household owner or admin can ${action} this record.`,
    );
}

export function requireRevision(
  actual: number,
  expected: number,
  action: 'edit' | 'void' = 'edit',
) {
  if (actual !== expected)
    throw new ApiError(
      409,
      'STALE_RECORD',
      `This record changed. Reload it and preview your ${action} action again.`,
    );
}

export async function createEditPreview(
  db: Db,
  householdId: string,
  resourceType: FinancialResource,
  resourceId: string,
  userId: string,
  revision: number,
  requestHash: string,
): Promise<{ previewId: string; expiresAt: string }> {
  await db.query(
    `DELETE FROM housemate.financial_edit_previews WHERE expires_at <= now()`,
  );
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO housemate.financial_edit_previews
     (household_id, resource_type, resource_id, requested_by_user_id, expected_revision, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expires_at`,
    [householdId, resourceType, resourceId, userId, revision, requestHash],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Edit preview could not be stored');
  return { previewId: row.id, expiresAt: row.expires_at.toISOString() };
}

export async function requireEditPreview(
  db: PoolClient,
  previewId: string,
  householdId: string,
  resourceType: FinancialResource,
  resourceId: string,
  userId: string,
  revision: number,
  requestHash: string,
) {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM housemate.financial_edit_previews
     WHERE id = $1 AND household_id = $2 AND resource_type = $3 AND resource_id = $4
       AND requested_by_user_id = $5 AND expected_revision = $6
       AND request_hash = $7 AND expires_at > now() FOR UPDATE`,
    [
      previewId,
      householdId,
      resourceType,
      resourceId,
      userId,
      revision,
      requestHash,
    ],
  );
  if (!result.rows[0])
    throw new ApiError(
      409,
      'PREVIEW_REQUIRED',
      'Your preview expired or the details changed. Preview again before confirming.',
    );
}

export async function priorEdit<T>(
  db: PoolClient,
  householdId: string,
  userId: string,
  key: string,
  resourceType: FinancialResource,
  resourceId: string,
  requestHash: string,
): Promise<T | null> {
  const result = await db.query<{
    resource_type: FinancialResource;
    resource_id: string;
    request_hash: string;
    after_record: T;
  }>(
    `SELECT resource_type, resource_id, request_hash, after_record
     FROM housemate.financial_edit_events
     WHERE household_id = $1 AND changed_by_user_id = $2 AND idempotency_key = $3`,
    [householdId, userId, key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.resource_type !== resourceType ||
    row.resource_id !== resourceId ||
    row.request_hash !== requestHash
  )
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This retry key was used for a different action. Preview again.',
    );
  return row.after_record;
}

export async function recordEdit(
  db: PoolClient,
  householdId: string,
  resourceType: FinancialResource,
  resourceId: string,
  userId: string,
  key: string,
  requestHash: string,
  revision: number,
  before: unknown,
  after: unknown,
  previewId: string,
  action: 'edit' | 'void' = 'edit',
) {
  await db.query(
    `INSERT INTO housemate.financial_edit_events
     (household_id, resource_type, resource_id, changed_by_user_id, idempotency_key,
      request_hash, before_revision, after_revision, before_record, after_record, action)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      householdId,
      resourceType,
      resourceId,
      userId,
      key,
      requestHash,
      revision,
      revision + 1,
      JSON.stringify(before),
      JSON.stringify(after),
      action,
    ],
  );
  await db.query(
    `DELETE FROM housemate.financial_edit_previews WHERE id = $1`,
    [previewId],
  );
}
