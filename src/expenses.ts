import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';
import { calculateShares } from './expense-calculation.js';
import type {
  Expense,
  ExpenseDraft,
  ExpenseEditPreview,
  ExpensePreview,
  ExpenseRepository,
  ExpenseShare,
} from './expense-types.js';
import {
  canonicalExpense,
  createEditPreview,
  editRequestHash,
  priorEdit,
  recordEdit,
  requireEditPermission,
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

interface Access {
  currency: 'USD' | 'THB';
  user_id: string;
  role: 'owner' | 'admin' | 'member';
}

interface ExpenseRow {
  id: string;
  household_id: string;
  title: string;
  amount_minor: string;
  currency: 'USD' | 'THB';
  spent_on: string;
  payer_member_id: string;
  payer_display_name: string;
  split_method: Expense['splitMethod'];
  created_by_display_name: string;
  created_at: Date;
  created_by_user_id: string;
  split_input: Expense['splitInput'];
  revision: number;
  updated_at: Date;
  voided_at: Date | null;
  voided_by_display_name: string | null;
  void_reason: string | null;
}

const columns = `e.id, e.household_id, e.title, e.amount_minor, e.currency, e.spent_on::text AS spent_on,
  e.payer_member_id, payer_user.display_name AS payer_display_name, e.split_method,
  creator.display_name AS created_by_display_name, e.created_at,
  e.created_by_user_id, e.split_input, e.revision, e.updated_at,
  e.voided_at, voider.display_name AS voided_by_display_name, e.void_reason`;
const joins = `JOIN housemate.household_members payer ON payer.id = e.payer_member_id
  JOIN housemate.users payer_user ON payer_user.id = payer.user_id
  JOIN housemate.users creator ON creator.id = e.created_by_user_id
  LEFT JOIN housemate.users voider ON voider.id = e.voided_by_user_id`;

export class PgExpenseRepository implements ExpenseRepository {
  constructor(private readonly pool: Pool) {}

  private async access(
    client: Pool | PoolClient,
    authUserId: string,
    householdId: string,
    lock = false,
  ) {
    const result = await client.query<Access>(
      `SELECT h.default_currency AS currency, u.id AS user_id, m.role
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2 AND h.archived_at IS NULL
       ${lock ? 'FOR UPDATE OF h' : ''}`,
      [householdId, authUserId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return row;
  }

  private async members(client: Pool | PoolClient, householdId: string) {
    const result = await client.query<{ id: string; display_name: string }>(
      `SELECT m.id, u.display_name FROM housemate.household_members m
       JOIN housemate.users u ON u.id = m.user_id
       WHERE m.household_id = $1 AND m.status = 'active'`,
      [householdId],
    );
    return new Map(result.rows.map((row) => [row.id, row.display_name]));
  }

  async preview(
    authUserId: string,
    householdId: string,
    draft: ExpenseDraft,
  ): Promise<ExpensePreview> {
    const access = await this.access(this.pool, authUserId, householdId);
    if (draft.currency !== access.currency)
      throw new ApiError(
        400,
        'CURRENCY_MISMATCH',
        `This household uses ${access.currency}.`,
      );
    return {
      title: draft.title.trim(),
      amountMinor: draft.amountMinor,
      currency: access.currency,
      spentOn: draft.spentOn,
      payerMemberId: draft.payerMemberId,
      splitMethod: draft.split.method,
      shares: calculateShares(
        draft,
        await this.members(this.pool, householdId),
      ),
    };
  }

  async create(
    authUserId: string,
    householdId: string,
    draft: ExpenseDraft,
    idempotencyKey: string,
    transactionClient?: PoolClient,
  ): Promise<Expense> {
    const client = transactionClient ?? (await this.pool.connect());
    try {
      if (!transactionClient) await client.query('BEGIN');
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
        split: {
          method: draft.split.method,
          shares: [...draft.split.shares].sort((a, b) =>
            a.memberId.localeCompare(b.memberId),
          ),
        },
      };
      const requestHash = createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex');
      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM housemate.expenses WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This retry key was already used for a different expense. Preview again and confirm as a new expense.',
          );
        const existing = await this.read(
          client,
          householdId,
          prior.rows[0].id,
          access,
        );
        if (!existing) throw new Error('Confirmed expense could not be read');
        if (!transactionClient) await client.query('COMMIT');
        return existing;
      }
      const preview: ExpensePreview = {
        title: draft.title.trim(),
        amountMinor: draft.amountMinor,
        currency: access.currency,
        spentOn: draft.spentOn,
        payerMemberId: draft.payerMemberId,
        splitMethod: draft.split.method,
        shares: calculateShares(draft, await this.members(client, householdId)),
      };
      const created = await client.query<{ id: string }>(
        `INSERT INTO housemate.expenses
         (household_id, title, amount_minor, currency, spent_on, payer_member_id, split_method, split_input, created_by_user_id, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          householdId,
          preview.title,
          preview.amountMinor,
          preview.currency,
          preview.spentOn,
          preview.payerMemberId,
          preview.splitMethod,
          JSON.stringify(draft.split),
          access.user_id,
          idempotencyKey,
          requestHash,
        ],
      );
      const expenseId = created.rows[0]?.id;
      if (!expenseId) throw new Error('Could not create expense');
      for (const share of preview.shares) {
        await client.query(
          `INSERT INTO housemate.expense_shares (expense_id, member_id, amount_minor) VALUES ($1,$2,$3)`,
          [expenseId, share.memberId, share.amountMinor],
        );
      }
      await client.query(
        `UPDATE housemate.households SET currency_locked_at = COALESCE(currency_locked_at, now()) WHERE id = $1`,
        [householdId],
      );
      const expense = await this.read(client, householdId, expenseId, access);
      if (!expense) throw new Error('Created expense could not be read');
      if (!transactionClient) await client.query('COMMIT');
      return expense;
    } catch (error) {
      if (!transactionClient) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transactionClient) client.release();
    }
  }

  private async read(
    client: Pool | PoolClient,
    householdId: string,
    expenseId: string,
    access: Access,
  ): Promise<Expense | null> {
    const result = await client.query<ExpenseRow>(
      `SELECT ${columns} FROM housemate.expenses e ${joins} WHERE e.household_id = $1 AND e.id = $2`,
      [householdId, expenseId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const shares = await client.query<{
      member_id: string;
      display_name: string;
      amount_minor: string;
    }>(
      `SELECT s.member_id, u.display_name, s.amount_minor FROM housemate.expense_shares s
       JOIN housemate.household_members m ON m.id = s.member_id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE s.expense_id = $1 ORDER BY s.member_id`,
      [expenseId],
    );
    return {
      id: row.id,
      householdId: row.household_id,
      title: row.title,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      spentOn: row.spent_on,
      payerMemberId: row.payer_member_id,
      payerDisplayName: row.payer_display_name,
      splitMethod: row.split_method,
      createdByDisplayName: row.created_by_display_name,
      createdAt: row.created_at.toISOString(),
      splitInput: row.split_input,
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
      canEdit:
        row.voided_at === null &&
        (row.created_by_user_id === access.user_id ||
          access.role === 'owner' ||
          access.role === 'admin'),
      canVoid:
        row.voided_at === null &&
        (row.created_by_user_id === access.user_id ||
          access.role === 'owner' ||
          access.role === 'admin'),
      voidedAt: row.voided_at?.toISOString() ?? null,
      voidedByDisplayName: row.voided_by_display_name,
      voidReason: row.void_reason,
      shares: shares.rows.map(
        (share): ExpenseShare => ({
          memberId: share.member_id,
          displayName: share.display_name,
          amountMinor: Number(share.amount_minor),
        }),
      ),
    };
  }

  async get(
    authUserId: string,
    householdId: string,
    expenseId: string,
  ): Promise<Expense | null> {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, expenseId, access);
  }

  async list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Expense[]> {
    const access = await this.access(this.pool, authUserId, householdId);
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM housemate.expenses WHERE household_id = $1
       ORDER BY spent_on DESC, created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return Promise.all(
      result.rows.map(async (row) => {
        const expense = await this.read(this.pool, householdId, row.id, access);
        if (!expense) throw new Error('Listed expense could not be read');
        return expense;
      }),
    );
  }

  async history(
    authUserId: string,
    householdId: string,
    expenseId: string,
    limit: number,
    offset: number,
  ) {
    const access = await this.access(this.pool, authUserId, householdId);
    const expense = await this.read(this.pool, householdId, expenseId, access);
    if (!expense) throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
    return readFinancialHistory(
      this.pool,
      'expense',
      householdId,
      expenseId,
      expense,
      limit,
      offset,
    );
  }

  async previewEdit(
    authUserId: string,
    householdId: string,
    expenseId: string,
    draft: ExpenseDraft,
    expectedRevision: number,
  ): Promise<ExpenseEditPreview> {
    const access = await this.access(this.pool, authUserId, householdId);
    const current = await this.read(this.pool, householdId, expenseId, access);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
    if (current.voidedAt)
      throw new ApiError(
        409,
        'ALREADY_VOIDED',
        'This expense was voided and cannot be edited.',
      );
    if (!current.canEdit)
      requireEditPermission(access.user_id, access.role, 'another user');
    requireRevision(current.revision, expectedRevision);
    if (draft.currency !== access.currency)
      throw new ApiError(
        400,
        'CURRENCY_MISMATCH',
        `This household uses ${access.currency}.`,
      );
    const canonical = canonicalExpense(draft);
    const shares = calculateShares(
      canonical,
      await this.members(this.pool, householdId),
    );
    const token = await createEditPreview(
      this.pool,
      householdId,
      'expense',
      expenseId,
      access.user_id,
      expectedRevision,
      editRequestHash(canonical, expectedRevision),
    );
    return {
      title: canonical.title,
      amountMinor: canonical.amountMinor,
      currency: canonical.currency,
      spentOn: canonical.spentOn,
      payerMemberId: canonical.payerMemberId,
      splitMethod: canonical.split.method,
      shares,
      expectedRevision,
      ...token,
    };
  }

  async edit(
    authUserId: string,
    householdId: string,
    expenseId: string,
    draft: ExpenseDraft,
    expectedRevision: number,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Expense> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const canonical = canonicalExpense(draft);
      const requestHash = editRequestHash(canonical, expectedRevision);
      const prior = await priorEdit<Expense>(
        client,
        householdId,
        access.user_id,
        idempotencyKey,
        'expense',
        expenseId,
        requestHash,
      );
      if (prior) {
        await client.query('COMMIT');
        return prior;
      }
      const lock = await client.query<{
        revision: number;
        created_by_user_id: string;
        voided_at: Date | null;
      }>(
        `SELECT revision, created_by_user_id, voided_at FROM housemate.expenses
         WHERE id = $1 AND household_id = $2 FOR UPDATE`,
        [expenseId, householdId],
      );
      const row = lock.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
      if (row.voided_at)
        throw new ApiError(
          409,
          'ALREADY_VOIDED',
          'This expense was voided and cannot be edited.',
        );
      requireEditPermission(
        access.user_id,
        access.role,
        row.created_by_user_id,
      );
      requireRevision(row.revision, expectedRevision);
      if (canonical.currency !== access.currency)
        throw new ApiError(
          400,
          'CURRENCY_MISMATCH',
          `This household uses ${access.currency}.`,
        );
      await requireEditPreview(
        client,
        previewId,
        householdId,
        'expense',
        expenseId,
        access.user_id,
        expectedRevision,
        requestHash,
      );
      const before = await this.read(client, householdId, expenseId, access);
      if (!before) throw new Error('Expense disappeared during edit');
      const shares = calculateShares(
        canonical,
        await this.members(client, householdId),
      );
      await client.query(
        `UPDATE housemate.expenses SET title = $3, amount_minor = $4, spent_on = $5,
         payer_member_id = $6, split_method = $7, split_input = $8,
         revision = revision + 1, updated_at = now()
         WHERE id = $1 AND household_id = $2`,
        [
          expenseId,
          householdId,
          canonical.title,
          canonical.amountMinor,
          canonical.spentOn,
          canonical.payerMemberId,
          canonical.split.method,
          JSON.stringify(canonical.split),
        ],
      );
      await client.query(
        `DELETE FROM housemate.expense_shares WHERE expense_id = $1`,
        [expenseId],
      );
      for (const share of shares)
        await client.query(
          `INSERT INTO housemate.expense_shares (expense_id, member_id, amount_minor) VALUES ($1,$2,$3)`,
          [expenseId, share.memberId, share.amountMinor],
        );
      const after = await this.read(client, householdId, expenseId, access);
      if (!after) throw new Error('Edited expense could not be read');
      await recordEdit(
        client,
        householdId,
        'expense',
        expenseId,
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
    expenseId: string,
    expectedRevision: number,
    reason?: string,
  ) {
    const access = await this.access(this.pool, authUserId, householdId);
    const current = await this.read(this.pool, householdId, expenseId, access);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
    if (current.voidedAt)
      throw new ApiError(
        409,
        'ALREADY_VOIDED',
        'This expense was already voided.',
      );
    if (!current.canVoid)
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the creator or a household owner or admin can void this expense.',
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
      true,
      false,
    );
    const token = await createEditPreview(
      this.pool,
      householdId,
      'expense',
      expenseId,
      access.user_id,
      expectedRevision,
      voidRequestHash(expectedRevision, cleaned),
    );
    return { ...effect, ...token };
  }

  async void(
    authUserId: string,
    householdId: string,
    expenseId: string,
    expectedRevision: number,
    reason: string | undefined,
    previewId: string,
    idempotencyKey: string,
  ): Promise<Expense> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const cleaned = cleanVoidReason(reason);
      const requestHash = voidRequestHash(expectedRevision, cleaned);
      const prior = await priorEdit<Expense>(
        client,
        householdId,
        access.user_id,
        idempotencyKey,
        'expense',
        expenseId,
        requestHash,
      );
      if (prior) {
        await client.query('COMMIT');
        return prior;
      }
      const lock = await client.query<{
        revision: number;
        created_by_user_id: string;
        voided_at: Date | null;
      }>(
        `SELECT revision, created_by_user_id, voided_at FROM housemate.expenses
         WHERE id = $1 AND household_id = $2 FOR UPDATE`,
        [expenseId, householdId],
      );
      const row = lock.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
      if (row.voided_at)
        throw new ApiError(
          409,
          'ALREADY_VOIDED',
          'This expense was already voided.',
        );
      requireEditPermission(
        access.user_id,
        access.role,
        row.created_by_user_id,
        'void',
      );
      requireRevision(row.revision, expectedRevision, 'void');
      await requireEditPreview(
        client,
        previewId,
        householdId,
        'expense',
        expenseId,
        access.user_id,
        expectedRevision,
        requestHash,
      );
      const before = await this.read(client, householdId, expenseId, access);
      if (!before) throw new Error('Expense disappeared during void');
      await client.query(
        `UPDATE housemate.expenses SET voided_at = now(), voided_by_user_id = $3,
         void_reason = $4, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND household_id = $2`,
        [expenseId, householdId, access.user_id, cleaned],
      );
      const after = await this.read(client, householdId, expenseId, access);
      if (!after) throw new Error('Voided expense could not be read');
      await recordEdit(
        client,
        householdId,
        'expense',
        expenseId,
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
