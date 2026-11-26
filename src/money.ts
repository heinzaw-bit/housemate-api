import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';
import {
  calculateSettlementPreview,
  suggestSettlements,
} from './money-calculation.js';
import type {
  BalanceEntry,
  BalanceSummary,
  MemberBalance,
  MoneyRepository,
  Settlement,
  SettlementDraft,
  SettlementPreview,
} from './money-types.js';
import type { Currency, HouseholdRole } from './types.js';

type Db = Pool | PoolClient;

interface Access {
  currency: Currency;
  user_id: string;
  member_id: string;
  role: HouseholdRole;
}

interface BalanceRow {
  member_id: string;
  display_name: string;
  status: MemberBalance['status'];
  net_minor: string;
  expected_net_minor: string;
  pending_bill_share_minor: string;
}

interface EntryRow {
  source_type: BalanceEntry['sourceType'];
  source_id: string;
  title: string;
  occurred_on: string;
  paid_minor: string;
  share_minor: string;
  sent_minor: string;
  received_minor: string;
}

interface SettlementRow {
  id: string;
  household_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  amount_minor: string;
  currency: Currency;
  settled_on: string;
  method: string | null;
  note: string | null;
  sender_display_name: string;
  recipient_display_name: string;
  recorded_by_display_name: string;
  created_at: Date;
}

const settlementColumns = `s.id, s.household_id, s.sender_member_id, s.recipient_member_id,
  s.amount_minor, s.currency, s.settled_on::text, s.method, s.note,
  sender_user.display_name AS sender_display_name,
  recipient_user.display_name AS recipient_display_name,
  recorder.display_name AS recorded_by_display_name, s.created_at`;
const settlementJoins = `JOIN housemate.household_members sender ON sender.id = s.sender_member_id
  JOIN housemate.users sender_user ON sender_user.id = sender.user_id
  JOIN housemate.household_members recipient ON recipient.id = s.recipient_member_id
  JOIN housemate.users recipient_user ON recipient_user.id = recipient.user_id
  JOIN housemate.users recorder ON recorder.id = s.recorded_by_user_id`;

function safeMinor(value: string | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error('Balance exceeds supported range');
  return number;
}

function settlementFromRow(row: SettlementRow): Settlement {
  return {
    id: row.id,
    householdId: row.household_id,
    senderMemberId: row.sender_member_id,
    recipientMemberId: row.recipient_member_id,
    senderDisplayName: row.sender_display_name,
    recipientDisplayName: row.recipient_display_name,
    amountMinor: safeMinor(row.amount_minor),
    currency: row.currency,
    settledOn: row.settled_on,
    method: row.method ?? undefined,
    note: row.note ?? undefined,
    recordedByDisplayName: row.recorded_by_display_name,
    createdAt: row.created_at.toISOString(),
  };
}

export class PgMoneyRepository implements MoneyRepository {
  constructor(private readonly pool: Pool) {}

  private async access(
    db: Db,
    authUserId: string,
    householdId: string,
    lock = false,
  ): Promise<Access> {
    const result = await db.query<Access>(
      `SELECT h.default_currency AS currency, u.id AS user_id, m.id AS member_id, m.role
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2 AND h.archived_at IS NULL
       ${lock ? 'FOR UPDATE OF h FOR SHARE OF m' : ''}`,
      [householdId, authUserId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return row;
  }

  private async balanceRows(
    db: Db,
    householdId: string,
  ): Promise<MemberBalance[]> {
    const result = await db.query<BalanceRow>(
      `WITH deltas AS (
         SELECT e.payer_member_id AS member_id, e.amount_minor AS delta
         FROM housemate.expenses e WHERE e.household_id = $1 AND e.voided_at IS NULL
         UNION ALL
         SELECT es.member_id, -es.amount_minor AS delta
         FROM housemate.expense_shares es
         JOIN housemate.expenses e ON e.id = es.expense_id
         WHERE e.household_id = $1 AND e.voided_at IS NULL
         UNION ALL
         SELECT b.payer_member_id AS member_id, b.amount_minor AS delta
         FROM housemate.bills b WHERE b.household_id = $1 AND b.payment_status = 'paid'
           AND b.voided_at IS NULL
         UNION ALL
         SELECT bs.member_id, -bs.amount_minor AS delta
         FROM housemate.bill_shares bs
         JOIN housemate.bills b ON b.id = bs.bill_id
         WHERE b.household_id = $1 AND b.payment_status = 'paid'
           AND b.voided_at IS NULL
         UNION ALL
         SELECT s.sender_member_id AS member_id, s.amount_minor AS delta
         FROM housemate.settlements s WHERE s.household_id = $1
         UNION ALL
         SELECT s.recipient_member_id AS member_id, -s.amount_minor AS delta
         FROM housemate.settlements s WHERE s.household_id = $1
       ), pending_bill_shares AS (
         SELECT bs.member_id, SUM(bs.amount_minor) AS pending_minor
         FROM housemate.bill_shares bs
         JOIN housemate.bills b ON b.id = bs.bill_id
         WHERE b.household_id = $1 AND b.payment_status = 'unpaid'
           AND b.voided_at IS NULL
         GROUP BY bs.member_id
       ), planned_bill_payments AS (
         SELECT b.payer_member_id AS member_id, SUM(b.amount_minor) AS planned_minor
         FROM housemate.bills b
         WHERE b.household_id = $1 AND b.payment_status = 'unpaid'
           AND b.voided_at IS NULL
         GROUP BY b.payer_member_id
       )
       SELECT m.id AS member_id, u.display_name, m.status,
         COALESCE(SUM(d.delta), 0)::text AS net_minor,
         (COALESCE(SUM(d.delta), 0) + COALESCE(planned.planned_minor, 0)
           - COALESCE(pending.pending_minor, 0))::text AS expected_net_minor,
         COALESCE(pending.pending_minor, 0)::text AS pending_bill_share_minor
       FROM housemate.household_members m
       JOIN housemate.users u ON u.id = m.user_id
       LEFT JOIN deltas d ON d.member_id = m.id
       LEFT JOIN pending_bill_shares pending ON pending.member_id = m.id
       LEFT JOIN planned_bill_payments planned ON planned.member_id = m.id
       WHERE m.household_id = $1 AND m.status <> 'invited'
       GROUP BY m.id, u.display_name, m.status, pending.pending_minor, planned.planned_minor
       ORDER BY u.display_name, m.id`,
      [householdId],
    );
    return result.rows.map((row) => {
      const netMinor = safeMinor(row.net_minor);
      return {
        memberId: row.member_id,
        displayName: row.display_name,
        status: row.status,
        netMinor,
        owesMinor: Math.max(-netMinor, 0),
        owedMinor: Math.max(netMinor, 0),
        expectedNetMinor:
          row.expected_net_minor === undefined
            ? netMinor
            : safeMinor(row.expected_net_minor),
        pendingBillShareMinor: safeMinor(row.pending_bill_share_minor ?? '0'),
      };
    });
  }

  private async balancesWithin(
    db: Db,
    householdId: string,
    access: Access,
  ): Promise<BalanceSummary> {
    const [members, pending] = await Promise.all([
      this.balanceRows(db, householdId),
      db.query<{ pending_count: string; pending_minor: string }>(
        `SELECT count(*)::text AS pending_count, COALESCE(SUM(amount_minor), 0)::text AS pending_minor
         FROM housemate.bills WHERE household_id = $1 AND payment_status = 'unpaid'
           AND voided_at IS NULL`,
        [householdId],
      ),
    ]);
    const pendingRow = pending.rows[0];
    return {
      householdId,
      currency: access.currency,
      viewerMemberId: access.member_id,
      members,
      suggestions: suggestSettlements(members),
      pendingBillCount: safeMinor(pendingRow?.pending_count ?? '0'),
      pendingBillAmountMinor: safeMinor(pendingRow?.pending_minor ?? '0'),
    };
  }

  async balances(
    authUserId: string,
    householdId: string,
    db: Db = this.pool,
  ): Promise<BalanceSummary> {
    const access = await this.access(db, authUserId, householdId);
    return this.balancesWithin(db, householdId, access);
  }

  async entries(
    authUserId: string,
    householdId: string,
    memberId: string,
    limit: number,
    offset: number,
  ): Promise<BalanceEntry[]> {
    await this.access(this.pool, authUserId, householdId);
    const member = await this.pool.query(
      `SELECT 1 FROM housemate.household_members WHERE id = $1 AND household_id = $2 AND status <> 'invited'`,
      [memberId, householdId],
    );
    if (!member.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
    const result = await this.pool.query<EntryRow>(
      `WITH entries AS (
         SELECT 'expense'::text AS source_type, e.id AS source_id, e.title,
           e.spent_on::text AS occurred_on, e.created_at,
           CASE WHEN e.payer_member_id = $2 THEN e.amount_minor ELSE 0 END AS paid_minor,
           COALESCE(es.amount_minor, 0) AS share_minor,
           0::bigint AS sent_minor, 0::bigint AS received_minor
         FROM housemate.expenses e
         LEFT JOIN housemate.expense_shares es ON es.expense_id = e.id AND es.member_id = $2
         WHERE e.household_id = $1 AND e.voided_at IS NULL
           AND (e.payer_member_id = $2 OR es.member_id = $2)
         UNION ALL
         SELECT 'bill'::text, b.id, b.title, b.due_date::text, b.created_at,
           CASE WHEN b.payer_member_id = $2 THEN b.amount_minor ELSE 0 END,
           COALESCE(bs.amount_minor, 0), 0::bigint, 0::bigint
         FROM housemate.bills b
         LEFT JOIN housemate.bill_shares bs ON bs.bill_id = b.id AND bs.member_id = $2
         WHERE b.household_id = $1 AND b.payment_status = 'paid'
           AND b.voided_at IS NULL
           AND (b.payer_member_id = $2 OR bs.member_id = $2)
         UNION ALL
         SELECT 'settlement'::text, s.id,
           'Transfer with ' || CASE WHEN s.sender_member_id = $2
             THEN recipient_user.display_name ELSE sender_user.display_name END,
           s.settled_on::text, s.created_at, 0::bigint, 0::bigint,
           CASE WHEN s.sender_member_id = $2 THEN s.amount_minor ELSE 0 END,
           CASE WHEN s.recipient_member_id = $2 THEN s.amount_minor ELSE 0 END
         FROM housemate.settlements s
         JOIN housemate.household_members sender ON sender.id = s.sender_member_id
         JOIN housemate.users sender_user ON sender_user.id = sender.user_id
         JOIN housemate.household_members recipient ON recipient.id = s.recipient_member_id
         JOIN housemate.users recipient_user ON recipient_user.id = recipient.user_id
         WHERE s.household_id = $1 AND (s.sender_member_id = $2 OR s.recipient_member_id = $2)
       )
       SELECT source_type, source_id, title, occurred_on,
         paid_minor::text, share_minor::text, sent_minor::text, received_minor::text
       FROM entries ORDER BY occurred_on DESC, created_at DESC, source_id DESC, source_type
       LIMIT $3 OFFSET $4`,
      [householdId, memberId, limit, offset],
    );
    return result.rows.map((row) => {
      const paidMinor = safeMinor(row.paid_minor);
      const shareMinor = safeMinor(row.share_minor);
      const sentMinor = safeMinor(row.sent_minor);
      const receivedMinor = safeMinor(row.received_minor);
      return {
        sourceType: row.source_type,
        sourceId: row.source_id,
        title: row.title,
        occurredOn: row.occurred_on,
        paidMinor,
        shareMinor,
        sentMinor,
        receivedMinor,
        effectMinor: paidMinor - shareMinor + sentMinor - receivedMinor,
      };
    });
  }

  private checkSettlementDraftAccess(draft: SettlementDraft, access: Access) {
    if (access.role !== 'owner')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the household owner can record transfers.',
      );
    if (
      draft.senderMemberId !== access.member_id &&
      draft.recipientMemberId !== access.member_id
    )
      throw new ApiError(
        403,
        'FORBIDDEN',
        'The owner can record transfers they sent or received.',
      );
    if (draft.currency !== access.currency)
      throw new ApiError(
        400,
        'CURRENCY_MISMATCH',
        `This household uses ${access.currency}.`,
      );
  }

  async previewSettlement(
    authUserId: string,
    householdId: string,
    draft: SettlementDraft,
  ): Promise<SettlementPreview> {
    const access = await this.access(this.pool, authUserId, householdId);
    this.checkSettlementDraftAccess(draft, access);
    const summary = await this.balancesWithin(this.pool, householdId, access);
    return calculateSettlementPreview(draft, summary.members);
  }

  private async readSettlement(
    db: Db,
    householdId: string,
    settlementId: string,
  ): Promise<Settlement | null> {
    const result = await db.query<SettlementRow>(
      `SELECT ${settlementColumns} FROM housemate.settlements s ${settlementJoins}
       WHERE s.household_id = $1 AND s.id = $2`,
      [householdId, settlementId],
    );
    return result.rows[0] ? settlementFromRow(result.rows[0]) : null;
  }

  async createSettlement(
    authUserId: string,
    householdId: string,
    draft: SettlementDraft,
    key: string,
  ): Promise<Settlement> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      this.checkSettlementDraftAccess(draft, access);
      const canonical = {
        ...draft,
        method: draft.method?.trim() || undefined,
        note: draft.note?.trim() || undefined,
      };
      const requestHash = createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex');
      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM housemate.settlements WHERE household_id = $1 AND recorded_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This retry key was used for a different transfer. Preview again.',
          );
        const existing = await this.readSettlement(
          client,
          householdId,
          prior.rows[0].id,
        );
        if (!existing) throw new Error('Recorded transfer could not be read');
        await client.query('COMMIT');
        return existing;
      }
      const summary = await this.balancesWithin(client, householdId, access);
      const preview = calculateSettlementPreview(canonical, summary.members);
      const result = await client.query<{ id: string }>(
        `INSERT INTO housemate.settlements
         (household_id, sender_member_id, recipient_member_id, amount_minor, currency,
          settled_on, method, note, recorded_by_user_id, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          householdId,
          preview.senderMemberId,
          preview.recipientMemberId,
          preview.amountMinor,
          preview.currency,
          preview.settledOn,
          preview.method ?? null,
          preview.note ?? null,
          access.user_id,
          key,
          requestHash,
        ],
      );
      const settlementId = result.rows[0]?.id;
      if (!settlementId) throw new Error('Could not record transfer');
      await client.query(
        `UPDATE housemate.households SET currency_locked_at = COALESCE(currency_locked_at, now()) WHERE id = $1`,
        [householdId],
      );
      const settlement = await this.readSettlement(
        client,
        householdId,
        settlementId,
      );
      if (!settlement) throw new Error('Created transfer could not be read');
      await client.query('COMMIT');
      return settlement;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listSettlements(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Settlement[]> {
    await this.access(this.pool, authUserId, householdId);
    const result = await this.pool.query<SettlementRow>(
      `SELECT ${settlementColumns} FROM housemate.settlements s ${settlementJoins}
       WHERE s.household_id = $1 ORDER BY s.settled_on DESC, s.created_at DESC, s.id DESC
       LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return result.rows.map(settlementFromRow);
  }

  async getSettlement(
    authUserId: string,
    householdId: string,
    settlementId: string,
  ): Promise<Settlement | null> {
    await this.access(this.pool, authUserId, householdId);
    return this.readSettlement(this.pool, householdId, settlementId);
  }
}
