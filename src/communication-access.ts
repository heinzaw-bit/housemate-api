import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';

export interface CommunicationAccess {
  memberId: string;
  userId: string;
  timezone: string;
  moderator: boolean;
}

export async function withCommunicationAccess<T>(
  pool: Pool,
  authUserId: string,
  householdId: string,
  write: boolean,
  action: (client: PoolClient, access: CommunicationAccess) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const result = await client.query<{
      member_id: string;
      user_id: string;
      timezone: string;
      role: string;
    }>(
      `SELECT m.id AS member_id, u.id AS user_id, h.timezone, m.role
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id AND m.status = 'active'
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2 AND h.archived_at IS NULL
       ${write ? 'FOR SHARE OF h, m' : ''}`,
      [householdId, authUserId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    const response = await action(client, {
      memberId: row.member_id,
      userId: row.user_id,
      timezone: row.timezone,
      moderator: row.role === 'owner' || row.role === 'admin',
    });
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function normalizedMemberIds(memberIds: string[]): string[] {
  const ids = [...new Set(memberIds)].sort();
  if (ids.length !== memberIds.length || ids.length < 1 || ids.length > 100)
    throw new ApiError(
      400,
      'INVALID_RECIPIENTS',
      'Choose 1–100 different active household members.',
    );
  return ids;
}

export async function checkActiveRecipients(
  client: PoolClient,
  householdId: string,
  ids: string[],
) {
  const members = await client.query(
    `SELECT id FROM housemate.household_members
     WHERE household_id = $1 AND status = 'active' AND id = ANY($2::uuid[]) FOR SHARE`,
    [householdId, ids],
  );
  if (members.rows.length !== ids.length)
    throw new ApiError(
      400,
      'INVALID_RECIPIENTS',
      'Select active members of this household.',
    );
}

export async function futureLocalTime(
  client: PoolClient,
  local: string,
  timezone: string,
): Promise<Date> {
  const parsed = new Date(`${local}:00Z`);
  if (
    !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 16) !== local
  )
    throw new ApiError(
      400,
      'INVALID_TIME',
      'Enter a valid date and time in the household timezone.',
    );
  const result = await client.query<{
    time: Date;
    round_trip: string;
    future: boolean;
  }>(
    `SELECT ($1::timestamp AT TIME ZONE $2) AS time,
      to_char(($1::timestamp AT TIME ZONE $2) AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI') AS round_trip,
      ($1::timestamp AT TIME ZONE $2) > clock_timestamp() AS future`,
    [local, timezone],
  );
  const time = result.rows[0];
  if (!time || time.round_trip !== local || !time.future)
    throw new ApiError(
      400,
      'INVALID_TIME',
      'Choose a future date and time. Check the household timezone.',
    );
  return time.time;
}
