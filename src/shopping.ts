import type { Pool, PoolClient } from 'pg';
import { priorCreate } from './create-request.js';
import { ApiError } from './errors.js';
import type { Expense, ExpenseDraft } from './expense-types.js';
import { PgExpenseRepository } from './expenses.js';

export interface ShoppingDraft {
  title: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  priority: 'low' | 'normal' | 'high';
  assignedBuyerMemberId: string | null;
  estimatedPriceMinor: number | null;
}
export interface ShoppingItem extends ShoppingDraft {
  id: string;
  householdId: string;
  currency: 'USD' | 'THB';
  status: 'needed' | 'assigned' | 'purchased' | 'cancelled';
  assignedBuyerDisplayName: string | null;
  purchasedPriceMinor: number | null;
  purchasedByDisplayName: string | null;
  purchasedAt: string | null;
  cancelledAt: string | null;
  linkedExpenseId: string | null;
  linkedExpenseVoidedAt: string | null;
  createdByDisplayName: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  viewerMemberId: string;
}
export interface ShoppingRepository {
  list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<ShoppingItem[]>;
  get(
    authUserId: string,
    householdId: string,
    itemId: string,
  ): Promise<ShoppingItem | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: ShoppingDraft,
    idempotencyKey?: string,
  ): Promise<ShoppingItem>;
  edit(
    authUserId: string,
    householdId: string,
    itemId: string,
    draft: ShoppingDraft,
    expectedRevision: number,
  ): Promise<ShoppingItem>;
  cancel(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
  ): Promise<ShoppingItem>;
  purchase(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
    purchasedPriceMinor: number | null,
  ): Promise<ShoppingItem>;
  purchaseWithExpense(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
    expenseDraft: ExpenseDraft,
    idempotencyKey: string,
  ): Promise<{ item: ShoppingItem; expense: Expense }>;
}

interface Access {
  user_id: string;
  member_id: string;
  currency: 'USD' | 'THB';
}
interface ItemRow {
  id: string;
  household_id: string;
  currency: 'USD' | 'THB';
  title: string;
  quantity: string | null;
  unit: string | null;
  note: string | null;
  priority: ShoppingDraft['priority'];
  assigned_buyer_member_id: string | null;
  status: ShoppingItem['status'];
  estimated_price_minor: string | null;
  purchased_price_minor: string | null;
  purchased_at: Date | null;
  cancelled_at: Date | null;
  linked_expense_id: string | null;
  linked_expense_voided_at: Date | null;
  created_at: Date;
  updated_at: Date;
  revision: number;
  created_by_display_name: string;
  assigned_buyer_display_name: string | null;
  purchased_by_display_name: string | null;
}
const columns = `si.*, creator.display_name AS created_by_display_name,
  buyer_user.display_name AS assigned_buyer_display_name,
  purchaser_user.display_name AS purchased_by_display_name,
  e.voided_at AS linked_expense_voided_at`;
const joins = `JOIN housemate.users creator ON creator.id = si.created_by_user_id
  LEFT JOIN housemate.household_members buyer ON buyer.id = si.assigned_buyer_member_id
  LEFT JOIN housemate.users buyer_user ON buyer_user.id = buyer.user_id
  LEFT JOIN housemate.household_members purchaser ON purchaser.id = si.purchased_by_member_id
  LEFT JOIN housemate.users purchaser_user ON purchaser_user.id = purchaser.user_id
  LEFT JOIN housemate.expenses e ON e.id = si.linked_expense_id AND e.household_id = si.household_id`;

function toItem(row: ItemRow, viewerMemberId: string): ShoppingItem {
  return {
    id: row.id,
    householdId: row.household_id,
    currency: row.currency,
    title: row.title,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unit: row.unit,
    note: row.note,
    priority: row.priority,
    assignedBuyerMemberId: row.assigned_buyer_member_id,
    assignedBuyerDisplayName: row.assigned_buyer_display_name,
    status: row.status,
    estimatedPriceMinor:
      row.estimated_price_minor === null
        ? null
        : Number(row.estimated_price_minor),
    purchasedPriceMinor:
      row.purchased_price_minor === null
        ? null
        : Number(row.purchased_price_minor),
    purchasedByDisplayName: row.purchased_by_display_name,
    purchasedAt: row.purchased_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    linkedExpenseId: row.linked_expense_id,
    linkedExpenseVoidedAt: row.linked_expense_voided_at?.toISOString() ?? null,
    createdByDisplayName: row.created_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: row.revision,
    viewerMemberId,
  };
}
function cleanDraft(draft: ShoppingDraft): ShoppingDraft {
  const title = draft.title.trim();
  const unit = draft.unit?.trim() || null;
  const note = draft.note?.trim() || null;
  if (!title || title.length > 160)
    throw new ApiError(
      400,
      'INVALID_TITLE',
      'Enter an item name up to 160 characters.',
    );
  if (unit && unit.length > 40)
    throw new ApiError(
      400,
      'INVALID_UNIT',
      'Unit must be at most 40 characters.',
    );
  if (note && note.length > 500)
    throw new ApiError(
      400,
      'INVALID_NOTE',
      'Note must be at most 500 characters.',
    );
  if (
    draft.quantity !== null &&
    (!Number.isFinite(draft.quantity) ||
      draft.quantity <= 0 ||
      draft.quantity > 999999999 ||
      Math.abs(Math.round(draft.quantity * 1000) - draft.quantity * 1000) >
        0.000001)
  )
    throw new ApiError(
      400,
      'INVALID_QUANTITY',
      'Quantity must be positive with at most three decimals.',
    );
  if (
    draft.estimatedPriceMinor !== null &&
    (!Number.isSafeInteger(draft.estimatedPriceMinor) ||
      draft.estimatedPriceMinor < 0 ||
      draft.estimatedPriceMinor > 999999999999)
  )
    throw new ApiError(400, 'INVALID_PRICE', 'Enter a valid estimated price.');
  return { ...draft, title, unit, note };
}
function checkRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError(
      409,
      'STALE_ITEM',
      'This item changed. Refresh it before continuing.',
    );
}
function requireOpen(status: ShoppingItem['status']) {
  if (status === 'cancelled' || status === 'purchased')
    throw new ApiError(
      409,
      'ITEM_CLOSED',
      'This item is already purchased or cancelled.',
    );
}

export class PgShoppingRepository implements ShoppingRepository {
  private readonly expenses: PgExpenseRepository;
  constructor(private readonly pool: Pool) {
    this.expenses = new PgExpenseRepository(pool);
  }

  private async lockCurrency(client: PoolClient, householdId: string) {
    await client.query(
      `UPDATE housemate.households
       SET currency_locked_at = COALESCE(currency_locked_at, now()) WHERE id = $1`,
      [householdId],
    );
  }

  private async access(
    client: Pool | PoolClient,
    authUserId: string,
    householdId: string,
    lock = false,
  ): Promise<Access> {
    const result = await client.query<Access>(
      `SELECT u.id AS user_id, m.id AS member_id, h.default_currency AS currency FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND h.archived_at IS NULL AND u.auth_user_id = $2
       ${lock ? 'FOR UPDATE OF h' : ''}`,
      [householdId, authUserId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return result.rows[0];
  }
  private async buyer(
    client: Pool | PoolClient,
    householdId: string,
    memberId: string | null,
  ) {
    if (!memberId) return;
    const result = await client.query(
      `SELECT id FROM housemate.household_members WHERE household_id = $1 AND id = $2 AND status = 'active'`,
      [householdId, memberId],
    );
    if (!result.rows[0])
      throw new ApiError(
        400,
        'INVALID_BUYER',
        'Choose an active member of this household.',
      );
  }
  private async read(
    client: Pool | PoolClient,
    householdId: string,
    itemId: string,
    viewerMemberId: string,
  ): Promise<ShoppingItem | null> {
    const result = await client.query<ItemRow>(
      `SELECT ${columns} FROM housemate.shopping_items si ${joins}
       WHERE si.household_id = $1 AND si.id = $2`,
      [householdId, itemId],
    );
    return result.rows[0] ? toItem(result.rows[0], viewerMemberId) : null;
  }
  private async locked(
    client: PoolClient,
    householdId: string,
    itemId: string,
  ): Promise<{
    id: string;
    title: string;
    status: ShoppingItem['status'];
    revision: number;
    linked_expense_id: string | null;
  }> {
    const result = await client.query<{
      id: string;
      title: string;
      status: ShoppingItem['status'];
      revision: number;
      linked_expense_id: string | null;
    }>(
      'SELECT id, title, status, revision, linked_expense_id FROM housemate.shopping_items WHERE household_id = $1 AND id = $2 FOR UPDATE',
      [householdId, itemId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Shopping item not found.');
    return result.rows[0];
  }

  async list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<ShoppingItem[]> {
    const access = await this.access(this.pool, authUserId, householdId);
    const result = await this.pool.query<ItemRow>(
      `SELECT ${columns} FROM housemate.shopping_items si ${joins}
       WHERE si.household_id = $1 ORDER BY
         CASE si.status WHEN 'needed' THEN 0 WHEN 'assigned' THEN 0 WHEN 'purchased' THEN 1 ELSE 2 END,
         CASE si.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         si.updated_at DESC, si.id DESC LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return result.rows.map((row) => toItem(row, access.member_id));
  }
  async get(
    authUserId: string,
    householdId: string,
    itemId: string,
  ): Promise<ShoppingItem | null> {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, itemId, access.member_id);
  }
  async create(
    authUserId: string,
    householdId: string,
    input: ShoppingDraft,
    idempotencyKey?: string,
  ): Promise<ShoppingItem> {
    const draft = cleanDraft(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const prior = await priorCreate(
        client,
        'shopping_items',
        householdId,
        access.user_id,
        idempotencyKey,
        {
          title: draft.title,
          quantity: draft.quantity,
          unit: draft.unit,
          note: draft.note,
          priority: draft.priority,
          assignedBuyerMemberId: draft.assignedBuyerMemberId,
          estimatedPriceMinor: draft.estimatedPriceMinor,
        },
      );
      if (prior.id) {
        const item = await this.read(
          client,
          householdId,
          prior.id,
          access.member_id,
        );
        if (!item) throw new Error('Could not read confirmed shopping item');
        await client.query('COMMIT');
        return item;
      }
      await this.buyer(client, householdId, draft.assignedBuyerMemberId);
      const created = await client.query<{ id: string }>(
        `INSERT INTO housemate.shopping_items
         (household_id, currency, title, quantity, unit, note, priority, assigned_buyer_member_id,
          status, estimated_price_minor, created_by_user_id, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          householdId,
          access.currency,
          draft.title,
          draft.quantity,
          draft.unit,
          draft.note,
          draft.priority,
          draft.assignedBuyerMemberId,
          draft.assignedBuyerMemberId ? 'assigned' : 'needed',
          draft.estimatedPriceMinor,
          access.user_id,
          idempotencyKey ?? null,
          prior.hash,
        ],
      );
      if (draft.estimatedPriceMinor !== null)
        await this.lockCurrency(client, householdId);
      const createdId = created.rows[0]?.id;
      if (!createdId) throw new Error('Could not create shopping item');
      const item = await this.read(
        client,
        householdId,
        createdId,
        access.member_id,
      );
      await client.query('COMMIT');
      if (!item) throw new Error('Could not read shopping item');
      return item;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async edit(
    authUserId: string,
    householdId: string,
    itemId: string,
    input: ShoppingDraft,
    expectedRevision: number,
  ): Promise<ShoppingItem> {
    const draft = cleanDraft(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const old = await this.locked(client, householdId, itemId);
      checkRevision(old.revision, expectedRevision);
      requireOpen(old.status);
      await this.buyer(client, householdId, draft.assignedBuyerMemberId);
      await client.query(
        `UPDATE housemate.shopping_items SET title = $2, quantity = $3, unit = $4, note = $5,
           priority = $6, assigned_buyer_member_id = $7, status = $8, estimated_price_minor = $9,
           currency = $10,
           revision = revision + 1, updated_at = now() WHERE id = $1`,
        [
          itemId,
          draft.title,
          draft.quantity,
          draft.unit,
          draft.note,
          draft.priority,
          draft.assignedBuyerMemberId,
          draft.assignedBuyerMemberId ? 'assigned' : 'needed',
          draft.estimatedPriceMinor,
          access.currency,
        ],
      );
      if (draft.estimatedPriceMinor !== null)
        await this.lockCurrency(client, householdId);
      const item = await this.read(
        client,
        householdId,
        itemId,
        access.member_id,
      );
      await client.query('COMMIT');
      if (!item) throw new Error('Could not read shopping item');
      return item;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async cancel(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
  ): Promise<ShoppingItem> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const old = await this.locked(client, householdId, itemId);
      checkRevision(old.revision, expectedRevision);
      requireOpen(old.status);
      await client.query(
        `UPDATE housemate.shopping_items SET status = 'cancelled', cancelled_at = now(),
          revision = revision + 1, updated_at = now() WHERE id = $1`,
        [itemId],
      );
      const item = await this.read(
        client,
        householdId,
        itemId,
        access.member_id,
      );
      await client.query('COMMIT');
      if (!item) throw new Error('Could not read shopping item');
      return item;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async purchase(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
    purchasedPriceMinor: number | null,
  ): Promise<ShoppingItem> {
    if (
      purchasedPriceMinor !== null &&
      (!Number.isSafeInteger(purchasedPriceMinor) ||
        purchasedPriceMinor < 0 ||
        purchasedPriceMinor > 999999999999)
    )
      throw new ApiError(
        400,
        'INVALID_PRICE',
        'Enter a valid purchased price.',
      );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const old = await this.locked(client, householdId, itemId);
      checkRevision(old.revision, expectedRevision);
      requireOpen(old.status);
      await client.query(
        `UPDATE housemate.shopping_items SET status = 'purchased', purchased_price_minor = $2,
          purchased_by_member_id = $3, purchased_at = now(), revision = revision + 1,
          currency = $4, updated_at = now() WHERE id = $1`,
        [itemId, purchasedPriceMinor, access.member_id, access.currency],
      );
      if (purchasedPriceMinor !== null)
        await this.lockCurrency(client, householdId);
      const item = await this.read(
        client,
        householdId,
        itemId,
        access.member_id,
      );
      await client.query('COMMIT');
      if (!item) throw new Error('Could not read shopping item');
      return item;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async purchaseWithExpense(
    authUserId: string,
    householdId: string,
    itemId: string,
    expectedRevision: number,
    expenseDraft: ExpenseDraft,
    idempotencyKey: string,
  ): Promise<{ item: ShoppingItem; expense: Expense }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId, true);
      const old = await this.locked(client, householdId, itemId);
      if (
        expenseDraft.title.trim() !==
        `Shopping: ${Array.from(old.title).slice(0, 150).join('')}`
      )
        throw new ApiError(
          400,
          'INVALID_EXPENSE',
          'Preview the expense for this shopping item again.',
        );
      if (old.status === 'purchased' && old.linked_expense_id) {
        const previous = await client.query<{
          idempotency_key: string;
          created_by_user_id: string;
        }>(
          'SELECT idempotency_key, created_by_user_id FROM housemate.expenses WHERE id = $1 AND household_id = $2',
          [old.linked_expense_id, householdId],
        );
        if (
          previous.rows[0]?.idempotency_key !== idempotencyKey ||
          previous.rows[0]?.created_by_user_id !== access.user_id
        )
          throw new ApiError(
            409,
            'ITEM_CLOSED',
            'This item was already purchased.',
          );
        const expense = await this.expenses.create(
          authUserId,
          householdId,
          expenseDraft,
          idempotencyKey,
          client,
        );
        const item = await this.read(
          client,
          householdId,
          itemId,
          access.member_id,
        );
        if (!item || expense.id !== old.linked_expense_id)
          throw new Error('Linked expense mismatch');
        await client.query('COMMIT');
        return { item, expense };
      }
      checkRevision(old.revision, expectedRevision);
      requireOpen(old.status);
      const usedKey = await client.query<{ id: string }>(
        `SELECT id FROM housemate.expenses WHERE household_id = $1
         AND created_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, idempotencyKey],
      );
      if (usedKey.rows[0])
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This confirmation key was already used for another expense. Preview again.',
        );
      const expense = await this.expenses.create(
        authUserId,
        householdId,
        expenseDraft,
        idempotencyKey,
        client,
      );
      await client.query(
        `UPDATE housemate.shopping_items SET status = 'purchased', purchased_price_minor = $2,
          purchased_by_member_id = $3, purchased_at = now(), linked_expense_id = $4,
          currency = $5, revision = revision + 1, updated_at = now() WHERE id = $1`,
        [
          itemId,
          expense.amountMinor,
          access.member_id,
          expense.id,
          access.currency,
        ],
      );
      const item = await this.read(
        client,
        householdId,
        itemId,
        access.member_id,
      );
      await client.query('COMMIT');
      if (!item) throw new Error('Could not read shopping item');
      return { item, expense };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
