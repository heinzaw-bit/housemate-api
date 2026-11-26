import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { calculateBill } from './bill-calculation.js';
import type {
  Bill,
  BillDraft,
  BillEditPreview,
  BillPaymentStatus,
  BillPreview,
  BillRepository,
} from './bill-types.js';
import { ApiError } from './errors.js';
import {
  canonicalBill,
  createEditPreview,
  editRequestHash,
  priorEdit,
  recordEdit,
  requireEditPreview,
  requireRevision,
} from './financial-edits.js';
import { readFinancialHistory } from './financial-history.js';
import { PgMoneyRepository } from './money.js';
import {
  calculateVoidEffect,
  cleanVoidReason,
  voidRequestHash,
} from './void-calculation.js';

type Db = Pool | PoolClient;
interface Access {
  currency: Bill['currency'];
  user_id: string;
  role: 'owner' | 'admin' | 'member';
}

function canManageBills(role: Access['role']) {
  return role === 'owner' || role === 'admin';
}

function requireBillManager(access: Access) {
  if (!canManageBills(access.role))
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only a household owner or admin can change a saved bill.',
    );
}

interface BillRow {
  id: string;
  household_id: string;
  title: string;
  bill_type: Bill['billType'];
  provider: string;
  amount_minor: string;
  currency: Bill['currency'];
  period_start: string;
  period_end: string;
  due_date: string;
  payer_member_id: string;
  payer_display_name: string;
  payment_status: BillPaymentStatus;
  shared_participant_ids: string[];
  adjustments: BillDraft['adjustments'];
  base_minor: string;
  charge_minor: string;
  credit_minor: string;
  created_by_display_name: string;
  created_at: Date;
  status_updated_at: Date;
  revision: number;
  updated_at: Date;
  voided_at: Date | null;
  voided_by_display_name: string | null;
  void_reason: string | null;
}

const columns = `b.id, b.household_id, b.title, b.bill_type, b.provider, b.amount_minor,
  b.currency, b.period_start::text, b.period_end::text, b.due_date::text,
  b.payer_member_id, payer_user.display_name AS payer_display_name,
  b.payment_status, b.shared_participant_ids, b.adjustments, b.base_minor,
  b.charge_minor, b.credit_minor, creator.display_name AS created_by_display_name,
  b.created_at, b.status_updated_at, b.revision, b.updated_at,
  b.voided_at, voider.display_name AS voided_by_display_name, b.void_reason`;
const joins = `JOIN housemate.household_members payer ON payer.id = b.payer_member_id
  JOIN housemate.users payer_user ON payer_user.id = payer.user_id
  JOIN housemate.users creator ON creator.id = b.created_by_user_id
  LEFT JOIN housemate.users voider ON voider.id = b.voided_by_user_id`;

export class PgBillRepository implements BillRepository {
  constructor(private readonly pool: Pool) {}

  private async access(
    db: Db,
    authUserId: string,
    householdId: string,
    lock = false,
  ) {
    const result = await db.query<Access>(
      `SELECT h.default_currency AS currency, u.id AS user_id, m.role
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2 AND h.archived_at IS NULL
       ${lock ? 'FOR UPDATE OF h FOR SHARE OF m' : ''}`,
      [householdId, authUserId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return result.rows[0];
  }

  private async members(db: Db, householdId: string, includeInactive = false) {
    const result = await db.query<{ id: string; display_name: string }>(
      `SELECT m.id, u.display_name FROM housemate.household_members m
       JOIN housemate.users u ON u.id = m.user_id
       WHERE m.household_id = $1 ${includeInactive ? '' : "AND m.status = 'active'"}`,
      [householdId],
    );
    return new Map(result.rows.map((row) => [row.id, row.display_name]));
  }

  async preview(
    authUserId: string,
    householdId: string,
    draft: BillDraft,
  ): Promise<BillPreview> {
    const access = await this.access(this.pool, authUserId, householdId);
    if (draft.currency !== access.currency)
      throw new ApiError(
        400,
        'CURRENCY_MISMATCH',
        `This household uses ${access.currency}.`,
      );
    return calculateBill(draft, await this.members(this.pool, householdId));
  }

  private async read(
    db: Db,
    householdId: string,
    billId: string,
    access: Access,
  ): Promise<Bill | null> {
    const result = await db.query<BillRow>(
      `SELECT ${columns} FROM housemate.bills b ${joins} WHERE b.household_id = $1 AND b.id = $2`,
      [householdId, billId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const shareResult = await db.query<{
      member_id: string;
      display_name: string;
      base_minor: string;
      adjustment_minor: string;
      amount_minor: string;
    }>(
      `SELECT s.member_id, u.display_name, s.base_minor, s.adjustment_minor, s.amount_minor
       FROM housemate.bill_shares s JOIN housemate.household_members m ON m.id = s.member_id
       JOIN housemate.users u ON u.id = m.user_id WHERE s.bill_id = $1 ORDER BY s.member_id`,
      [billId],
    );
    const memberNames = await this.members(db, householdId, true);
    const reconstructed: BillDraft = {
      title: row.title,
      billType: row.bill_type,
      provider: row.provider,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      dueDate: row.due_date,
      payerMemberId: row.payer_member_id,
      paymentStatus: row.payment_status,
      sharedParticipantIds: row.shared_participant_ids,
      adjustments: row.adjustments,
    };
    return {
      ...reconstructed,
      baseMinor: Number(row.base_minor),
      chargeMinor: Number(row.charge_minor),
      creditMinor: Number(row.credit_minor),
      adjustmentBreakdown: row.adjustments.map((item) => {
        const sorted = [...item.memberIds].sort();
        const each = Math.floor(item.amountMinor / sorted.length);
        const extra = item.amountMinor % sorted.length;
        return {
          ...item,
          shares: sorted.map((memberId, index) => ({
            memberId,
            displayName: memberNames.get(memberId) ?? '',
            amountMinor: each + (index < extra ? 1 : 0),
          })),
        };
      }),
      shares: shareResult.rows.map((share) => ({
        memberId: share.member_id,
        displayName: share.display_name,
        baseMinor: Number(share.base_minor),
        adjustmentMinor: Number(share.adjustment_minor),
        amountMinor: Number(share.amount_minor),
      })),
      id: row.id,
      householdId: row.household_id,
      payerDisplayName: row.payer_display_name,
      createdByDisplayName: row.created_by_display_name,
      createdAt: row.created_at.toISOString(),
      statusUpdatedAt: row.status_updated_at.toISOString(),
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
      canEdit: row.voided_at === null && canManageBills(access.role),
      canVoid: row.voided_at === null && canManageBills(access.role),
      voidedAt: row.voided_at?.toISOString() ?? null,
      voidedByDisplayName: row.voided_by_display_name,
      voidReason: row.void_reason,
    };
  }

  async create(
    authUserId: string,
    householdId: string,
    draft: BillDraft,
    key: string,
  ): Promise<Bill> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      if (draft.currency !== access.currency)
        throw new ApiError(
          400,
          'CURRENCY_MISMATCH',
          `This household uses ${access.currency}.`,
        );
      const canonical = {
        ...draft,
        title: draft.title.trim(),
        provider: draft.provider.trim(),
        sharedParticipantIds: [...draft.sharedParticipantIds].sort(),
        adjustments: draft.adjustments.map((item) => ({
          ...item,
          label: item.label.trim(),
          memberIds: [...item.memberIds].sort(),
        })),
      };
      const requestHash = createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex');
      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM housemate.bills WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This retry key was used for a different bill. Preview again.',
          );
        const original = await this.read(
          client,
          householdId,
          prior.rows[0].id,
          access,
        );
        if (!original) throw new Error('Confirmed bill could not be read');
        await client.query('COMMIT');
        return original;
      }
      const preview = calculateBill(
        canonical,
        await this.members(client, householdId),
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO housemate.bills
         (household_id, title, bill_type, provider, amount_minor, currency, period_start,
          period_end, due_date, payer_member_id, payment_status, shared_participant_ids,
          adjustments, base_minor, charge_minor, credit_minor, created_by_user_id,
          idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          householdId,
          preview.title,
          preview.billType,
          preview.provider,
          preview.amountMinor,
          preview.currency,
          preview.periodStart,
          preview.periodEnd,
          preview.dueDate,
          preview.payerMemberId,
          preview.paymentStatus,
          JSON.stringify(preview.sharedParticipantIds),
          JSON.stringify(preview.adjustments),
          preview.baseMinor,
          preview.chargeMinor,
          preview.creditMinor,
          access.user_id,
          key,
          requestHash,
        ],
      );
      const billId = result.rows[0]?.id;
      if (!billId) throw new Error('Could not create bill');
      for (const share of preview.shares) {
        await client.query(
          `INSERT INTO housemate.bill_shares (bill_id, member_id, base_minor, adjustment_minor, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
          [
            billId,
            share.memberId,
            share.baseMinor,
            share.adjustmentMinor,
            share.amountMinor,
          ],
        );
      }
      await client.query(
        `INSERT INTO housemate.bill_status_events (bill_id, old_status, new_status, changed_by_user_id) VALUES ($1,NULL,$2,$3)`,
        [billId, preview.paymentStatus, access.user_id],
      );
      await client.query(
        `UPDATE housemate.households SET currency_locked_at = COALESCE(currency_locked_at, now()) WHERE id = $1`,
        [householdId],
      );
      const bill = await this.read(client, householdId, billId, access);
      if (!bill) throw new Error('Created bill could not be read');
      await client.query('COMMIT');
      return bill;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(authUserId: string, householdId: string, billId: string) {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, billId, access);
  }

  async list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ) {
    const access = await this.access(this.pool, authUserId, householdId);
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id FROM housemate.bills WHERE household_id = $1 ORDER BY due_date DESC, created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return Promise.all(
      rows.rows.map(async ({ id }) => {
        const bill = await this.read(this.pool, householdId, id, access);
        if (!bill) throw new Error('Listed bill could not be read');
        return bill;
      }),
    );
  }

  async history(
    authUserId: string,
    householdId: string,
    billId: string,
    limit: number,
    offset: number,
  ) {
    const access = await this.access(this.pool, authUserId, householdId);
    const bill = await this.read(this.pool, householdId, billId, access);
    if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
    return readFinancialHistory(
      this.pool,
      'bill',
      householdId,
      billId,
      bill,
      limit,
      offset,
    );
  }

  async setStatus(
    authUserId: string,
    householdId: string,
    billId: string,
    status: BillPaymentStatus,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      requireBillManager(access);
      const current = await client.query<{
        payment_status: BillPaymentStatus;
        voided_at: Date | null;
      }>(
        `SELECT payment_status, voided_at FROM housemate.bills WHERE id = $1 AND household_id = $2 FOR UPDATE`,
        [billId, householdId],
      );
      const oldStatus = current.rows[0]?.payment_status;
      if (!oldStatus) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
      if (current.rows[0]?.voided_at)
        throw new ApiError(
          409,
          'ALREADY_VOIDED',
          'This bill was voided and its payment status cannot change.',
        );
      if (oldStatus !== status) {
        await client.query(
          `UPDATE housemate.bills SET payment_status = $3, status_updated_at = now(),
           revision = revision + 1, updated_at = now() WHERE id = $1 AND household_id = $2`,
          [billId, householdId, status],
        );
        await client.query(
          `INSERT INTO housemate.bill_status_events (bill_id, old_status, new_status, changed_by_user_id) VALUES ($1,$2,$3,$4)`,
          [billId, oldStatus, status, access.user_id],
        );
      }
      const bill = await this.read(client, householdId, billId, access);
      if (!bill) throw new Error('Updated bill could not be read');
      await client.query('COMMIT');
      return bill;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async previewEdit(
    authUserId: string,
    householdId: string,
    billId: string,
    draft: BillDraft,
    expectedRevision: number,
  ): Promise<BillEditPreview> {
    const access = await this.access(this.pool, authUserId, householdId);
    requireBillManager(access);
    const current = await this.read(this.pool, householdId, billId, access);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
    if (current.voidedAt)
      throw new ApiError(
        409,
        'ALREADY_VOIDED',
        'This bill was voided and cannot be edited.',
      );
    requireRevision(current.revision, expectedRevision);
    if (draft.currency !== access.currency)
      throw new ApiError(
        400,
        'CURRENCY_MISMATCH',
        `This household uses ${access.currency}.`,
      );
    if (draft.paymentStatus !== current.paymentStatus)
      throw new ApiError(
        409,
        'STALE_RECORD',
        'Bill payment status changed. Reload and preview again.',
      );
    const canonical = canonicalBill(draft);
    const preview = calculateBill(
      canonical,
      await this.members(this.pool, householdId),
    );
    const token = await createEditPreview(
      this.pool,
      householdId,
      'bill',
      billId,
      access.user_id,
      expectedRevision,
      editRequestHash(canonical, expectedRevision),
    );
    return { ...preview, expectedRevision, ...token };
  }

  async edit(
    authUserId: string,
    householdId: string,
    billId: string,
    draft: BillDraft,
    expectedRevision: number,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Bill> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      requireBillManager(access);
      const canonical = canonicalBill(draft);
      const requestHash = editRequestHash(canonical, expectedRevision);
      const prior = await priorEdit<Bill>(
        client,
        householdId,
        access.user_id,
        idempotencyKey,
        'bill',
        billId,
        requestHash,
      );
      if (prior) {
        await client.query('COMMIT');
        return prior;
      }
      const lock = await client.query<{
        revision: number;
        payment_status: BillPaymentStatus;
        voided_at: Date | null;
      }>(
        `SELECT revision, payment_status, voided_at FROM housemate.bills
         WHERE id = $1 AND household_id = $2 FOR UPDATE`,
        [billId, householdId],
      );
      const row = lock.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
      if (row.voided_at)
        throw new ApiError(
          409,
          'ALREADY_VOIDED',
          'This bill was voided and cannot be edited.',
        );
      requireRevision(row.revision, expectedRevision);
      if (canonical.currency !== access.currency)
        throw new ApiError(
          400,
          'CURRENCY_MISMATCH',
          `This household uses ${access.currency}.`,
        );
      if (canonical.paymentStatus !== row.payment_status)
        throw new ApiError(
          409,
          'STALE_RECORD',
          'Bill payment status changed. Reload and preview again.',
        );
      await requireEditPreview(
        client,
        previewId,
        householdId,
        'bill',
        billId,
        access.user_id,
        expectedRevision,
        requestHash,
      );
      const before = await this.read(client, householdId, billId, access);
      if (!before) throw new Error('Bill disappeared during edit');
      const preview = calculateBill(
        canonical,
        await this.members(client, householdId),
      );
      await client.query(
        `UPDATE housemate.bills SET title = $3, bill_type = $4, provider = $5,
         amount_minor = $6, period_start = $7, period_end = $8, due_date = $9,
         payer_member_id = $10, shared_participant_ids = $11, adjustments = $12,
         base_minor = $13, charge_minor = $14, credit_minor = $15,
         revision = revision + 1, updated_at = now()
         WHERE id = $1 AND household_id = $2`,
        [
          billId,
          householdId,
          preview.title,
          preview.billType,
          preview.provider,
          preview.amountMinor,
          preview.periodStart,
          preview.periodEnd,
          preview.dueDate,
          preview.payerMemberId,
          JSON.stringify(preview.sharedParticipantIds),
          JSON.stringify(preview.adjustments),
          preview.baseMinor,
          preview.chargeMinor,
          preview.creditMinor,
        ],
      );
      await client.query(
        `DELETE FROM housemate.bill_shares WHERE bill_id = $1`,
        [billId],
      );
      for (const share of preview.shares)
        await client.query(
          `INSERT INTO housemate.bill_shares (bill_id, member_id, base_minor, adjustment_minor, amount_minor)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            billId,
            share.memberId,
            share.baseMinor,
            share.adjustmentMinor,
            share.amountMinor,
          ],
        );
      const after = await this.read(client, householdId, billId, access);
      if (!after) throw new Error('Edited bill could not be read');
      await recordEdit(
        client,
        householdId,
        'bill',
        billId,
        access.user_id,
        idempotencyKey,
        requestHash,
        expectedRevision,
        before,
        after,
        previewId,
      );
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async previewVoid(
    authUserId: string,
    householdId: string,
    billId: string,
    expectedRevision: number,
    reason?: string,
  ) {
    const access = await this.access(this.pool, authUserId, householdId);
    requireBillManager(access);
    const current = await this.read(this.pool, householdId, billId, access);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
    if (current.voidedAt)
      throw new ApiError(
        409,
        'ALREADY_VOIDED',
        'This bill was already voided.',
      );
    requireRevision(current.revision, expectedRevision, 'void');
    const cleaned = cleanVoidReason(reason);
    const summary = await new PgMoneyRepository(this.pool).balances(
      authUserId,
      householdId,
    );
    const effect = calculateVoidEffect(
      current,
      summary,
      expectedRevision,
      cleaned,
      current.paymentStatus === 'paid',
      current.paymentStatus === 'unpaid',
    );
    const token = await createEditPreview(
      this.pool,
      householdId,
      'bill',
      billId,
      access.user_id,
      expectedRevision,
      voidRequestHash(expectedRevision, cleaned),
    );
    return { ...effect, ...token };
  }

  async void(
    authUserId: string,
    householdId: string,
    billId: string,
    expectedRevision: number,
    reason: string | undefined,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Bill> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      requireBillManager(access);
      const cleaned = cleanVoidReason(reason);
      const requestHash = voidRequestHash(expectedRevision, cleaned);
      const prior = await priorEdit<Bill>(
        client,
        householdId,
        access.user_id,
        idempotencyKey,
        'bill',
        billId,
        requestHash,
      );
      if (prior) {
        await client.query('COMMIT');
        return prior;
      }
      const lock = await client.query<{
        revision: number;
        voided_at: Date | null;
      }>(
        `SELECT revision, voided_at FROM housemate.bills
         WHERE id = $1 AND household_id = $2 FOR UPDATE`,
        [billId, householdId],
      );
      const row = lock.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
      if (row.voided_at)
        throw new ApiError(
          409,
          'ALREADY_VOIDED',
          'This bill was already voided.',
        );
      requireRevision(row.revision, expectedRevision, 'void');
      await requireEditPreview(
        client,
        previewId,
        householdId,
        'bill',
        billId,
        access.user_id,
        expectedRevision,
        requestHash,
      );
      const before = await this.read(client, householdId, billId, access);
      if (!before) throw new Error('Bill disappeared during void');
      await client.query(
        `UPDATE housemate.bills SET voided_at = now(), voided_by_user_id = $3,
         void_reason = $4, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND household_id = $2`,
        [billId, householdId, access.user_id, cleaned],
      );
      const after = await this.read(client, householdId, billId, access);
      if (!after) throw new Error('Voided bill could not be read');
      await recordEdit(
        client,
        householdId,
        'bill',
        billId,
        access.user_id,
        idempotencyKey,
        requestHash,
        expectedRevision,
        before,
        after,
        previewId,
        'void',
      );
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
