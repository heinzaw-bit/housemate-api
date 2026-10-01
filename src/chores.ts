import type { Pool, PoolClient } from 'pg';
import { priorCreate } from './create-request.js';
import { ApiError } from './errors.js';

export interface ChoreDraft {
  title: string;
  note: string | null;
  dueAtLocal: string;
  assigneeMemberId: string;
}
export interface Chore {
  id: string;
  householdId: string;
  title: string;
  note: string | null;
  dueAt: string;
  timezone: string;
  assigneeMemberId: string;
  assigneeDisplayName: string;
  status: 'open' | 'completed' | 'skipped';
  skipReason: string | null;
  closedAt: string | null;
  closedByDisplayName: string | null;
  createdByDisplayName: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  viewerMemberId: string;
  canManage: boolean;
  canComplete: boolean;
  canRequestSwap: boolean;
  pendingSwap: {
    id: string;
    requestedByMemberId: string;
    requestedByDisplayName: string;
    targetMemberId: string;
    targetDisplayName: string;
    createdAt: string;
    canRespond: boolean;
  } | null;
}
export interface ChoreRepository {
  list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Chore[]>;
  get(
    authUserId: string,
    householdId: string,
    choreId: string,
  ): Promise<Chore | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: ChoreDraft,
    idempotencyKey?: string,
  ): Promise<Chore>;
  reassign(
    authUserId: string,
    householdId: string,
    choreId: string,
    memberId: string,
    expectedRevision: number,
  ): Promise<Chore>;
  complete(
    authUserId: string,
    householdId: string,
    choreId: string,
    expectedRevision: number,
  ): Promise<Chore>;
  skip(
    authUserId: string,
    householdId: string,
    choreId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Chore>;
  requestSwap(
    authUserId: string,
    householdId: string,
    choreId: string,
    targetMemberId: string,
    expectedRevision: number,
  ): Promise<Chore>;
  respondSwap(
    authUserId: string,
    householdId: string,
    choreId: string,
    swapId: string,
    decision: 'accepted' | 'declined',
    expectedRevision: number,
  ): Promise<Chore>;
}

interface Access {
  member_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  timezone: string;
}
interface ChoreRow {
  id: string;
  household_id: string;
  title: string;
  note: string | null;
  due_at: Date;
  timezone: string;
  assignee_member_id: string;
  assignee_display_name: string;
  status: Chore['status'];
  skip_reason: string | null;
  closed_at: Date | null;
  closed_by_display_name: string | null;
  created_by_display_name: string;
  created_at: Date;
  updated_at: Date;
  revision: number;
  swap_id: string | null;
  swap_requested_by_member_id: string | null;
  swap_requested_by_display_name: string | null;
  swap_target_member_id: string | null;
  swap_target_display_name: string | null;
  swap_created_at: Date | null;
}
const detailSql = `SELECT c.*, assignee_user.display_name AS assignee_display_name,
    creator.display_name AS created_by_display_name,
    closer_user.display_name AS closed_by_display_name,
    swap.id AS swap_id, swap.requested_by_member_id AS swap_requested_by_member_id,
    requester_user.display_name AS swap_requested_by_display_name,
    swap.target_member_id AS swap_target_member_id,
    target_user.display_name AS swap_target_display_name,
    swap.created_at AS swap_created_at
  FROM housemate.chores c
  JOIN housemate.household_members assignee ON assignee.id = c.assignee_member_id
  JOIN housemate.users assignee_user ON assignee_user.id = assignee.user_id
  JOIN housemate.users creator ON creator.id = c.created_by_user_id
  LEFT JOIN housemate.household_members closer ON closer.id = c.closed_by_member_id
  LEFT JOIN housemate.users closer_user ON closer_user.id = closer.user_id
  LEFT JOIN LATERAL (
    SELECT id, requested_by_member_id, target_member_id, created_at
    FROM housemate.chore_swap_requests
    WHERE chore_id = c.id AND status = 'pending'
    LIMIT 1
  ) swap ON true
  LEFT JOIN housemate.household_members requester ON requester.id = swap.requested_by_member_id
  LEFT JOIN housemate.users requester_user ON requester_user.id = requester.user_id
  LEFT JOIN housemate.household_members target ON target.id = swap.target_member_id
  LEFT JOIN housemate.users target_user ON target_user.id = target.user_id`;
const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function validLocal(value: string): boolean {
  if (!localPattern.test(value)) return false;
  const parsed = new Date(`${value}:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 16) === value
  );
}
function revision(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError(
      409,
      'STALE_CHORE',
      'This chore changed. Refresh it before continuing.',
    );
}
function open(status: Chore['status']) {
  if (status !== 'open')
    throw new ApiError(
      409,
      'CHORE_CLOSED',
      'This chore is already completed or skipped.',
    );
}
function toChore(row: ChoreRow, access: Access): Chore {
  const canManage = access.role === 'owner' || access.role === 'admin';
  const pendingSwap =
    row.swap_id &&
    row.swap_requested_by_member_id &&
    row.swap_requested_by_display_name &&
    row.swap_target_member_id &&
    row.swap_target_display_name &&
    row.swap_created_at
      ? {
          id: row.swap_id,
          requestedByMemberId: row.swap_requested_by_member_id,
          requestedByDisplayName: row.swap_requested_by_display_name,
          targetMemberId: row.swap_target_member_id,
          targetDisplayName: row.swap_target_display_name,
          createdAt: row.swap_created_at.toISOString(),
          canRespond: row.swap_target_member_id === access.member_id,
        }
      : null;
  return {
    id: row.id,
    householdId: row.household_id,
    title: row.title,
    note: row.note,
    dueAt: row.due_at.toISOString(),
    timezone: row.timezone,
    assigneeMemberId: row.assignee_member_id,
    assigneeDisplayName: row.assignee_display_name,
    status: row.status,
    skipReason: row.skip_reason,
    closedAt: row.closed_at?.toISOString() ?? null,
    closedByDisplayName: row.closed_by_display_name,
    createdByDisplayName: row.created_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: row.revision,
    viewerMemberId: access.member_id,
    canManage,
    canComplete:
      row.status === 'open' &&
      (canManage || row.assignee_member_id === access.member_id),
    canRequestSwap:
      row.status === 'open' &&
      row.assignee_member_id === access.member_id &&
      !pendingSwap,
    pendingSwap,
  };
}

export class PgChoreRepository implements ChoreRepository {
  constructor(private readonly pool: Pool) {}
  private async access(
    client: Pool | PoolClient,
    authUserId: string,
    householdId: string,
    write = false,
  ): Promise<Access> {
    const result = await client.query<Access>(
      `SELECT m.id AS member_id, u.id AS user_id, m.role, h.timezone
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND h.archived_at IS NULL AND u.auth_user_id = $2 ${write ? 'FOR SHARE OF h, m' : ''}`,
      [householdId, authUserId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return result.rows[0];
  }
  private async activeMember(
    client: Pool | PoolClient,
    householdId: string,
    memberId: string,
  ) {
    const result = await client.query(
      `SELECT id FROM housemate.household_members WHERE household_id = $1 AND id = $2 AND status = 'active'`,
      [householdId, memberId],
    );
    if (!result.rows[0])
      throw new ApiError(
        400,
        'INVALID_ASSIGNEE',
        'Choose an active member of this household.',
      );
  }
  private async read(
    client: Pool | PoolClient,
    householdId: string,
    choreId: string,
    access: Access,
  ): Promise<Chore | null> {
    const result = await client.query<ChoreRow>(
      `${detailSql} WHERE c.household_id = $1 AND c.id = $2`,
      [householdId, choreId],
    );
    return result.rows[0] ? toChore(result.rows[0], access) : null;
  }
  private async locked(
    client: PoolClient,
    householdId: string,
    choreId: string,
  ) {
    const result = await client.query<{
      id: string;
      assignee_member_id: string;
      status: Chore['status'];
      revision: number;
    }>(
      `SELECT id, assignee_member_id, status, revision FROM housemate.chores WHERE household_id = $1 AND id = $2 FOR UPDATE`,
      [householdId, choreId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Chore not found.');
    return result.rows[0];
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async list(
    authUserId: string,
    householdId: string,
    limit: number,
    offset: number,
  ): Promise<Chore[]> {
    const access = await this.access(this.pool, authUserId, householdId);
    const result = await this.pool.query<ChoreRow>(
      `${detailSql} WHERE c.household_id = $1
       ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END,
         CASE WHEN c.status = 'open' THEN c.due_at END ASC,
         CASE WHEN c.status <> 'open' THEN c.closed_at END DESC, c.id ASC
       LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return result.rows.map((row) => toChore(row, access));
  }
  async get(
    authUserId: string,
    householdId: string,
    choreId: string,
  ): Promise<Chore | null> {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, choreId, access);
  }
  async create(
    authUserId: string,
    householdId: string,
    draft: ChoreDraft,
    idempotencyKey?: string,
  ): Promise<Chore> {
    const title = draft.title.trim();
    const note = draft.note?.trim() || null;
    if (!title || title.length > 160)
      throw new ApiError(
        400,
        'INVALID_TITLE',
        'Enter a chore title up to 160 characters.',
      );
    if (note && note.length > 500)
      throw new ApiError(
        400,
        'INVALID_NOTE',
        'Note must be at most 500 characters.',
      );
    if (!validLocal(draft.dueAtLocal))
      throw new ApiError(
        400,
        'INVALID_DUE_DATE',
        'Enter a valid due date and time.',
      );
    return this.transaction(async (client) => {
      const access = await this.access(client, authUserId, householdId, true);
      const prior = await priorCreate(
        client,
        'chores',
        householdId,
        access.user_id,
        idempotencyKey,
        {
          title,
          note,
          dueAtLocal: draft.dueAtLocal,
          assigneeMemberId: draft.assigneeMemberId,
        },
      );
      if (prior.id) {
        const chore = await this.read(client, householdId, prior.id, access);
        if (!chore) throw new Error('Could not read confirmed chore');
        return chore;
      }
      await this.activeMember(client, householdId, draft.assigneeMemberId);
      const converted = await client.query<{ due_at: Date; due_local: string }>(
        `SELECT ($1::timestamp AT TIME ZONE $2) AS due_at,
          to_char(($1::timestamp AT TIME ZONE $2) AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI') AS due_local`,
        [draft.dueAtLocal, access.timezone],
      );
      const due = converted.rows[0];
      if (
        !due ||
        due.due_local !== draft.dueAtLocal ||
        due.due_at.getTime() <= Date.now()
      )
        throw new ApiError(
          400,
          'INVALID_DUE_DATE',
          'Due date must be a future time in the household timezone.',
        );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO housemate.chores (household_id, title, note, due_at, timezone, assignee_member_id, created_by_user_id, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          householdId,
          title,
          note,
          due.due_at,
          access.timezone,
          draft.assigneeMemberId,
          access.user_id,
          idempotencyKey ?? null,
          prior.hash,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('Could not create chore');
      const chore = await this.read(client, householdId, id, access);
      if (!chore) throw new Error('Could not read created chore');
      return chore;
    });
  }
  async reassign(
    authUserId: string,
    householdId: string,
    choreId: string,
    memberId: string,
    expectedRevision: number,
  ): Promise<Chore> {
    return this.transaction(async (client) => {
      const access = await this.access(client, authUserId, householdId);
      const chore = await this.locked(client, householdId, choreId);
      revision(chore.revision, expectedRevision);
      open(chore.status);
      if (access.role === 'member')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only an owner or admin can reassign a chore.',
        );
      await this.activeMember(client, householdId, memberId);
      if (memberId === chore.assignee_member_id)
        throw new ApiError(
          400,
          'SAME_ASSIGNEE',
          'Choose a different assignee.',
        );
      await client.query(
        `UPDATE housemate.chore_swap_requests SET status = 'cancelled', responded_at = now()
        WHERE chore_id = $1 AND status = 'pending'`,
        [choreId],
      );
      await client.query(
        `UPDATE housemate.chores SET assignee_member_id = $2, revision = revision + 1, updated_at = now() WHERE id = $1`,
        [choreId, memberId],
      );
      const updated = await this.read(client, householdId, choreId, access);
      if (!updated) throw new Error('Could not read reassigned chore');
      return updated;
    });
  }
  private async close(
    authUserId: string,
    householdId: string,
    choreId: string,
    expectedRevision: number,
    status: 'completed' | 'skipped',
    reason: string | null,
  ): Promise<Chore> {
    return this.transaction(async (client) => {
      const access = await this.access(client, authUserId, householdId);
      const chore = await this.locked(client, householdId, choreId);
      revision(chore.revision, expectedRevision);
      open(chore.status);
      if (
        chore.assignee_member_id !== access.member_id &&
        access.role === 'member'
      )
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the assignee or an owner/admin can close this chore.',
        );
      await client.query(
        `UPDATE housemate.chore_swap_requests SET status = 'cancelled', responded_at = now()
        WHERE chore_id = $1 AND status = 'pending'`,
        [choreId],
      );
      await client.query(
        `UPDATE housemate.chores SET status = $2, skip_reason = $3,
        closed_at = now(), closed_by_member_id = $4, revision = revision + 1, updated_at = now() WHERE id = $1`,
        [choreId, status, reason, access.member_id],
      );
      const updated = await this.read(client, householdId, choreId, access);
      if (!updated) throw new Error('Could not read closed chore');
      return updated;
    });
  }
  complete(
    authUserId: string,
    householdId: string,
    choreId: string,
    expectedRevision: number,
  ) {
    return this.close(
      authUserId,
      householdId,
      choreId,
      expectedRevision,
      'completed',
      null,
    );
  }
  skip(
    authUserId: string,
    householdId: string,
    choreId: string,
    expectedRevision: number,
    reason: string,
  ) {
    const clean = reason.trim();
    if (!clean || clean.length > 500)
      throw new ApiError(
        400,
        'INVALID_REASON',
        'Give a reason up to 500 characters.',
      );
    return this.close(
      authUserId,
      householdId,
      choreId,
      expectedRevision,
      'skipped',
      clean,
    );
  }
  async requestSwap(
    authUserId: string,
    householdId: string,
    choreId: string,
    targetMemberId: string,
    expectedRevision: number,
  ): Promise<Chore> {
    return this.transaction(async (client) => {
      const access = await this.access(client, authUserId, householdId);
      const chore = await this.locked(client, householdId, choreId);
      revision(chore.revision, expectedRevision);
      open(chore.status);
      if (chore.assignee_member_id !== access.member_id)
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the assignee can request a swap.',
        );
      if (targetMemberId === access.member_id)
        throw new ApiError(
          400,
          'INVALID_TARGET',
          'Choose another member for the swap.',
        );
      await this.activeMember(client, householdId, targetMemberId);
      const existing = await client.query(
        `SELECT id FROM housemate.chore_swap_requests WHERE chore_id = $1 AND status = 'pending'`,
        [choreId],
      );
      if (existing.rows[0])
        throw new ApiError(
          409,
          'SWAP_PENDING',
          'This chore already has a pending swap request.',
        );
      await client.query(
        `INSERT INTO housemate.chore_swap_requests (chore_id, requested_by_member_id, target_member_id)
        VALUES ($1,$2,$3)`,
        [choreId, access.member_id, targetMemberId],
      );
      await client.query(
        `UPDATE housemate.chores SET revision = revision + 1, updated_at = now() WHERE id = $1`,
        [choreId],
      );
      const updated = await this.read(client, householdId, choreId, access);
      if (!updated) throw new Error('Could not read swap request');
      return updated;
    });
  }
  async respondSwap(
    authUserId: string,
    householdId: string,
    choreId: string,
    swapId: string,
    decision: 'accepted' | 'declined',
    expectedRevision: number,
  ): Promise<Chore> {
    return this.transaction(async (client) => {
      const access = await this.access(client, authUserId, householdId);
      const chore = await this.locked(client, householdId, choreId);
      revision(chore.revision, expectedRevision);
      open(chore.status);
      const result = await client.query<{
        target_member_id: string;
        requested_by_member_id: string;
      }>(
        `SELECT target_member_id, requested_by_member_id FROM housemate.chore_swap_requests
         WHERE id = $1 AND chore_id = $2 AND status = 'pending' FOR UPDATE`,
        [swapId, choreId],
      );
      const swap = result.rows[0];
      if (!swap)
        throw new ApiError(404, 'NOT_FOUND', 'Pending swap request not found.');
      if (swap.target_member_id !== access.member_id)
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the requested member can answer this swap.',
        );
      if (swap.requested_by_member_id !== chore.assignee_member_id)
        throw new ApiError(
          409,
          'STALE_CHORE',
          'The assignee changed. Refresh this chore.',
        );
      await client.query(
        `UPDATE housemate.chore_swap_requests SET status = $2, responded_at = now() WHERE id = $1`,
        [swapId, decision],
      );
      await client.query(
        `UPDATE housemate.chores SET assignee_member_id = $2, revision = revision + 1, updated_at = now() WHERE id = $1`,
        [
          choreId,
          decision === 'accepted' ? access.member_id : chore.assignee_member_id,
        ],
      );
      const updated = await this.read(client, householdId, choreId, access);
      if (!updated) throw new Error('Could not read answered swap');
      return updated;
    });
  }
}
