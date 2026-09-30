import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';

export type MealResponse = 'joining' | 'not_joining' | 'maybe';
export type MealListScope = 'all' | 'reply' | 'upcoming' | 'past';
export interface MealRole {
  memberId: string;
  role: string;
}
export interface MealDraft {
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'other';
  question: string;
  startsAtLocal: string;
  responseDeadlineLocal: string;
  participantIds: string[];
  cookingRoles: MealRole[];
  idempotencyKey: string;
}
export interface Meal {
  id: string;
  householdId: string;
  mealType: MealDraft['mealType'];
  question: string;
  startsAt: string;
  responseDeadline: string;
  timezone: string;
  createdAt: string;
  creatorDisplayName: string;
  viewerMemberId: string;
  participants: {
    memberId: string;
    displayName: string;
    response: MealResponse | null;
    respondedAt: string | null;
  }[];
  counts: {
    joining: number;
    notJoining: number;
    maybe: number;
    awaiting: number;
  };
  cookingRoles: (MealRole & { displayName: string })[];
  canRespond: boolean;
}
export interface MealRepository {
  list(
    authUserId: string,
    householdId: string,
    scope?: MealListScope,
    limit?: number,
    offset?: number,
  ): Promise<Meal[]>;
  get(
    authUserId: string,
    householdId: string,
    mealId: string,
  ): Promise<Meal | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: MealDraft,
  ): Promise<Meal>;
  respond(
    authUserId: string,
    householdId: string,
    mealId: string,
    response: MealResponse,
  ): Promise<Meal>;
  setRoles(
    authUserId: string,
    householdId: string,
    mealId: string,
    roles: MealRole[],
  ): Promise<Meal>;
}

interface Access {
  member_id: string;
  user_id: string;
  timezone: string;
}
interface MealRow {
  id: string;
  household_id: string;
  meal_type: MealDraft['mealType'];
  question: string;
  starts_at: Date;
  response_deadline: Date;
  timezone: string;
  created_at: Date;
  creator_display_name: string;
  viewer_member_id: string;
}
const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function validLocal(value: string): boolean {
  if (!localPattern.test(value)) return false;
  const parsed = new Date(`${value}:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 16) === value
  );
}

export class PgMealRepository implements MealRepository {
  constructor(private readonly pool: Pool) {}

  private async access(
    client: Pool | PoolClient,
    authUserId: string,
    householdId: string,
  ): Promise<Access> {
    const result = await client.query<Access>(
      `SELECT m.id AS member_id, u.id AS user_id, h.timezone
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2 AND h.archived_at IS NULL`,
      [householdId, authUserId],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return result.rows[0];
  }

  private async read(
    client: Pool | PoolClient,
    householdId: string,
    viewerMemberId: string,
    mealId: string,
  ): Promise<Meal | null> {
    const result = await client.query<MealRow>(
      `SELECT mc.*, u.display_name AS creator_display_name, $3::uuid AS viewer_member_id
       FROM housemate.meal_checks mc JOIN housemate.users u ON u.id = mc.created_by_user_id
       WHERE mc.household_id = $1 AND mc.id = $2`,
      [householdId, mealId, viewerMemberId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const people = await client.query<{
      member_id: string;
      display_name: string;
      response: MealResponse | null;
      responded_at: Date | null;
    }>(
      `SELECT mp.member_id, u.display_name, mp.response, mp.responded_at
       FROM housemate.meal_participants mp
       JOIN housemate.household_members m ON m.id = mp.member_id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE mp.meal_id = $1 ORDER BY u.display_name, mp.member_id`,
      [mealId],
    );
    const roles = await client.query<{
      member_id: string;
      display_name: string;
      role: string;
    }>(
      `SELECT cr.member_id, u.display_name, cr.role FROM housemate.meal_cooking_roles cr
       JOIN housemate.household_members m ON m.id = cr.member_id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE cr.meal_id = $1 ORDER BY cr.role, u.display_name`,
      [mealId],
    );
    const participants = people.rows.map((person) => ({
      memberId: person.member_id,
      displayName: person.display_name,
      response: person.response,
      respondedAt: person.responded_at?.toISOString() ?? null,
    }));
    return {
      id: row.id,
      householdId: row.household_id,
      mealType: row.meal_type,
      question: row.question,
      startsAt: row.starts_at.toISOString(),
      responseDeadline: row.response_deadline.toISOString(),
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      creatorDisplayName: row.creator_display_name,
      viewerMemberId,
      participants,
      counts: {
        joining: participants.filter((p) => p.response === 'joining').length,
        notJoining: participants.filter((p) => p.response === 'not_joining')
          .length,
        maybe: participants.filter((p) => p.response === 'maybe').length,
        awaiting: participants.filter((p) => p.response === null).length,
      },
      cookingRoles: roles.rows.map((role) => ({
        memberId: role.member_id,
        displayName: role.display_name,
        role: role.role,
      })),
      canRespond:
        row.response_deadline.getTime() > Date.now() &&
        participants.some((p) => p.memberId === viewerMemberId),
    };
  }

  async list(
    authUserId: string,
    householdId: string,
    scope: MealListScope = 'all',
    limit = 50,
    offset = 0,
  ): Promise<Meal[]> {
    const access = await this.access(this.pool, authUserId, householdId);
    const scopeClause = {
      all: '',
      reply: `AND response_deadline > now() AND starts_at > now()
        AND EXISTS (SELECT 1 FROM housemate.meal_participants mp
          WHERE mp.meal_id = meal_checks.id AND mp.member_id = $2
            AND mp.response IS NULL)`,
      upcoming: 'AND starts_at >= now()',
      past: 'AND starts_at < now()',
    }[scope];
    const paging =
      scope === 'reply'
        ? [householdId, access.member_id, limit, offset]
        : [householdId, limit, offset];
    const limitParam = scope === 'reply' ? '$3' : '$2';
    const offsetParam = scope === 'reply' ? '$4' : '$3';
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM housemate.meal_checks WHERE household_id = $1
       ${scopeClause}
       ORDER BY (starts_at < now()), CASE WHEN starts_at >= now() THEN starts_at END ASC,
         CASE WHEN starts_at < now() THEN starts_at END DESC, id ASC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      paging,
    );
    return (
      await Promise.all(
        result.rows.map((row) =>
          this.read(this.pool, householdId, access.member_id, row.id),
        ),
      )
    ).filter((meal): meal is Meal => meal !== null);
  }

  async get(
    authUserId: string,
    householdId: string,
    mealId: string,
  ): Promise<Meal | null> {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, access.member_id, mealId);
  }

  private async validMembers(
    client: PoolClient,
    householdId: string,
    memberIds: string[],
  ) {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM housemate.household_members WHERE household_id = $1 AND status = 'active' AND id = ANY($2::uuid[])`,
      [householdId, memberIds],
    );
    if (result.rows.length !== new Set(memberIds).size)
      throw new ApiError(
        400,
        'INVALID_MEMBERS',
        'Select active members of this household.',
      );
  }

  private validateRoles(roles: MealRole[], participantIds: string[]) {
    const seen = new Set<string>();
    for (const item of roles) {
      item.role = item.role.trim();
      if (
        !participantIds.includes(item.memberId) ||
        !item.role ||
        item.role.length > 60
      )
        throw new ApiError(
          400,
          'INVALID_ROLE',
          'Cooking roles must name selected participants and be 1–60 characters.',
        );
      const key = `${item.memberId}:${item.role.toLowerCase()}`;
      if (seen.has(key))
        throw new ApiError(
          400,
          'DUPLICATE_ROLE',
          'A member cannot have the same cooking role twice.',
        );
      seen.add(key);
    }
  }

  async create(
    authUserId: string,
    householdId: string,
    draft: MealDraft,
  ): Promise<Meal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`meal:${householdId}:${access.user_id}:${draft.idempotencyKey}`],
      );
      const participants = [...new Set(draft.participantIds)].sort();
      if (
        participants.length !== draft.participantIds.length ||
        participants.length < 1 ||
        participants.length > 100
      )
        throw new ApiError(
          400,
          'INVALID_PARTICIPANTS',
          'Choose 1–100 different household members.',
        );
      this.validateRoles(draft.cookingRoles, participants);
      if (
        !validLocal(draft.startsAtLocal) ||
        !validLocal(draft.responseDeadlineLocal)
      )
        throw new ApiError(
          400,
          'INVALID_TIME',
          'Enter a valid local date and time.',
        );
      const question = draft.question.trim();
      if (!question || question.length > 240)
        throw new ApiError(
          400,
          'INVALID_QUESTION',
          'Enter a question up to 240 characters.',
        );
      const normalizedRoles = draft.cookingRoles
        .map((r) => ({ memberId: r.memberId, role: r.role.trim() }))
        .sort((a, b) =>
          `${a.memberId}:${a.role}`.localeCompare(`${b.memberId}:${b.role}`),
        );
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            mealType: draft.mealType,
            question,
            startsAtLocal: draft.startsAtLocal,
            responseDeadlineLocal: draft.responseDeadlineLocal,
            participants,
            roles: normalizedRoles,
          }),
        )
        .digest('hex');
      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM housemate.meal_checks WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, draft.idempotencyKey],
      );
      let id = prior.rows[0]?.id;
      if (id && prior.rows[0]?.request_hash !== hash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This meal request key was already used for different details.',
        );
      if (!id) {
        await this.validMembers(client, householdId, participants);
        const converted = await client.query<{
          starts_at: Date;
          deadline: Date;
          starts_local: string;
          deadline_local: string;
        }>(
          `SELECT ($1::timestamp AT TIME ZONE $3) AS starts_at,
            ($2::timestamp AT TIME ZONE $3) AS deadline,
            to_char(($1::timestamp AT TIME ZONE $3) AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
            to_char(($2::timestamp AT TIME ZONE $3) AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI') AS deadline_local`,
          [draft.startsAtLocal, draft.responseDeadlineLocal, access.timezone],
        );
        const clock = converted.rows[0];
        if (
          !clock ||
          clock.starts_local !== draft.startsAtLocal ||
          clock.deadline_local !== draft.responseDeadlineLocal ||
          clock.deadline.getTime() <= Date.now() ||
          clock.starts_at.getTime() <= clock.deadline.getTime()
        )
          throw new ApiError(
            400,
            'INVALID_TIME',
            'The response deadline must be in the future and before the meal. Check the household timezone.',
          );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO housemate.meal_checks (household_id, meal_type, question, starts_at, response_deadline, timezone, created_by_user_id, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            householdId,
            draft.mealType,
            question,
            clock.starts_at,
            clock.deadline,
            access.timezone,
            access.user_id,
            draft.idempotencyKey,
            hash,
          ],
        );
        id = inserted.rows[0]?.id;
        if (!id) throw new Error('Could not create meal');
        for (const memberId of participants)
          await client.query(
            'INSERT INTO housemate.meal_participants (meal_id, member_id) VALUES ($1,$2)',
            [id, memberId],
          );
        for (const role of normalizedRoles)
          await client.query(
            'INSERT INTO housemate.meal_cooking_roles (meal_id, member_id, role) VALUES ($1,$2,$3)',
            [id, role.memberId, role.role],
          );
      }
      const meal = await this.read(client, householdId, access.member_id, id);
      await client.query('COMMIT');
      if (!meal) throw new Error('Could not read meal');
      return meal;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async respond(
    authUserId: string,
    householdId: string,
    mealId: string,
    response: MealResponse,
  ): Promise<Meal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId);
      const meal = await client.query<{ response_deadline: Date }>(
        'SELECT response_deadline FROM housemate.meal_checks WHERE household_id = $1 AND id = $2 FOR UPDATE',
        [householdId, mealId],
      );
      if (!meal.rows[0])
        throw new ApiError(404, 'NOT_FOUND', 'Meal not found.');
      if (meal.rows[0].response_deadline.getTime() <= Date.now())
        throw new ApiError(
          409,
          'DEADLINE_PASSED',
          'The response deadline has passed.',
        );
      const result = await client.query(
        `UPDATE housemate.meal_participants SET response = $3, responded_at = now()
         WHERE meal_id = $1 AND member_id = $2`,
        [mealId, access.member_id, response],
      );
      if (!result.rowCount)
        throw new ApiError(
          403,
          'NOT_INVITED',
          'You are not selected for this meal.',
        );
      const updated = await this.read(
        client,
        householdId,
        access.member_id,
        mealId,
      );
      await client.query('COMMIT');
      if (!updated) throw new Error('Could not read meal');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setRoles(
    authUserId: string,
    householdId: string,
    mealId: string,
    roles: MealRole[],
  ): Promise<Meal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId);
      const meal = await client.query(
        'SELECT id FROM housemate.meal_checks WHERE household_id = $1 AND id = $2 FOR UPDATE',
        [householdId, mealId],
      );
      if (!meal.rows[0])
        throw new ApiError(404, 'NOT_FOUND', 'Meal not found.');
      const people = await client.query<{ member_id: string }>(
        'SELECT member_id FROM housemate.meal_participants WHERE meal_id = $1',
        [mealId],
      );
      const participantIds = people.rows.map((p) => p.member_id);
      this.validateRoles(roles, participantIds);
      await this.validMembers(
        client,
        householdId,
        roles.map((r) => r.memberId),
      );
      await client.query(
        'DELETE FROM housemate.meal_cooking_roles WHERE meal_id = $1',
        [mealId],
      );
      for (const role of roles)
        await client.query(
          'INSERT INTO housemate.meal_cooking_roles (meal_id, member_id, role) VALUES ($1,$2,$3)',
          [mealId, role.memberId, role.role],
        );
      await client.query(
        'UPDATE housemate.meal_checks SET revision = revision + 1, updated_at = now() WHERE id = $1',
        [mealId],
      );
      const updated = await this.read(
        client,
        householdId,
        access.member_id,
        mealId,
      );
      await client.query('COMMIT');
      if (!updated) throw new Error('Could not read meal');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
