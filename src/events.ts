import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';

export type EventResponse = 'going' | 'maybe' | 'not_going';
export type EventScope = 'upcoming' | 'past';
export interface EventDraft {
  title: string;
  description?: string;
  location?: string;
  startsAtLocal: string;
  endsAtLocal?: string | null;
  idempotencyKey: string;
}
export interface HouseholdEvent {
  id: string;
  householdId: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  createdAt: string;
  creatorDisplayName: string;
  viewerMemberId: string;
  attendees: {
    memberId: string;
    displayName: string;
    response: EventResponse | null;
    respondedAt: string | null;
  }[];
  counts: { going: number; maybe: number; notGoing: number; awaiting: number };
  canRespond: boolean;
}
export interface EventRepository {
  list(
    authUserId: string,
    householdId: string,
    scope: EventScope,
    limit: number,
    offset: number,
  ): Promise<HouseholdEvent[]>;
  get(
    authUserId: string,
    householdId: string,
    eventId: string,
  ): Promise<HouseholdEvent | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: EventDraft,
  ): Promise<HouseholdEvent>;
  respond(
    authUserId: string,
    householdId: string,
    eventId: string,
    response: EventResponse,
  ): Promise<HouseholdEvent>;
}

interface Access {
  member_id: string;
  user_id: string;
  timezone: string;
}
interface EventRow {
  id: string;
  household_id: string;
  title: string;
  description: string;
  location: string;
  starts_at: Date;
  ends_at: Date | null;
  timezone: string;
  created_at: Date;
  creator_display_name: string;
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

export class PgEventRepository implements EventRepository {
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
    eventId: string,
  ): Promise<HouseholdEvent | null> {
    const result = await client.query<EventRow>(
      `SELECT e.*, u.display_name AS creator_display_name
       FROM housemate.events e JOIN housemate.users u ON u.id = e.created_by_user_id
       WHERE e.household_id = $1 AND e.id = $2`,
      [householdId, eventId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const people = await client.query<{
      member_id: string;
      display_name: string;
      response: EventResponse | null;
      responded_at: Date | null;
    }>(
      `SELECT m.id AS member_id, u.display_name, ea.response, ea.responded_at
       FROM housemate.household_members m
       JOIN housemate.users u ON u.id = m.user_id
       LEFT JOIN housemate.event_attendance ea ON ea.member_id = m.id AND ea.event_id = $2
       WHERE m.household_id = $1 AND m.status = 'active'
       ORDER BY u.display_name, m.id`,
      [householdId, eventId],
    );
    const attendees = people.rows.map((person) => ({
      memberId: person.member_id,
      displayName: person.display_name,
      response: person.response,
      respondedAt: person.responded_at?.toISOString() ?? null,
    }));
    return {
      id: row.id,
      householdId: row.household_id,
      title: row.title,
      description: row.description,
      location: row.location,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at?.toISOString() ?? null,
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      creatorDisplayName: row.creator_display_name,
      viewerMemberId,
      attendees,
      counts: {
        going: attendees.filter((person) => person.response === 'going').length,
        maybe: attendees.filter((person) => person.response === 'maybe').length,
        notGoing: attendees.filter((person) => person.response === 'not_going')
          .length,
        awaiting: attendees.filter((person) => person.response === null).length,
      },
      canRespond: row.starts_at.getTime() > Date.now(),
    };
  }

  async list(
    authUserId: string,
    householdId: string,
    scope: EventScope = 'upcoming',
    limit = 50,
    offset = 0,
  ): Promise<HouseholdEvent[]> {
    const access = await this.access(this.pool, authUserId, householdId);
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM housemate.events WHERE household_id = $1
       AND starts_at ${scope === 'upcoming' ? '>=' : '<'} now()
       ORDER BY starts_at ${scope === 'upcoming' ? 'ASC' : 'DESC'}, id ASC
       LIMIT $2 OFFSET $3`,
      [householdId, limit, offset],
    );
    return (
      await Promise.all(
        result.rows.map((row) =>
          this.read(this.pool, householdId, access.member_id, row.id),
        ),
      )
    ).filter((event): event is HouseholdEvent => event !== null);
  }

  async get(
    authUserId: string,
    householdId: string,
    eventId: string,
  ): Promise<HouseholdEvent | null> {
    const access = await this.access(this.pool, authUserId, householdId);
    return this.read(this.pool, householdId, access.member_id, eventId);
  }

  async create(
    authUserId: string,
    householdId: string,
    draft: EventDraft,
  ): Promise<HouseholdEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`event:${householdId}:${access.user_id}:${draft.idempotencyKey}`],
      );
      const title = draft.title.trim();
      const description = (draft.description ?? '').trim();
      const location = (draft.location ?? '').trim();
      const endsAtLocal = draft.endsAtLocal || null;
      if (
        !title ||
        title.length > 160 ||
        description.length > 1000 ||
        location.length > 160
      )
        throw new ApiError(
          400,
          'INVALID_EVENT',
          'Check the event title, description, and location.',
        );
      if (
        !validLocal(draft.startsAtLocal) ||
        (endsAtLocal !== null && !validLocal(endsAtLocal))
      )
        throw new ApiError(
          400,
          'INVALID_TIME',
          'Enter valid local date and time values.',
        );
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            title,
            description,
            location,
            startsAtLocal: draft.startsAtLocal,
            endsAtLocal,
          }),
        )
        .digest('hex');
      const prior = await client.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM housemate.events
         WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
        [householdId, access.user_id, draft.idempotencyKey],
      );
      let id = prior.rows[0]?.id;
      if (id && prior.rows[0]?.request_hash !== hash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This event request key was already used for different details.',
        );
      if (!id) {
        const converted = await client.query<{
          starts_at: Date;
          ends_at: Date | null;
          starts_local: string;
          ends_local: string | null;
        }>(
          `SELECT ($1::timestamp AT TIME ZONE $3) AS starts_at,
             (NULLIF($2, '')::timestamp AT TIME ZONE $3) AS ends_at,
             to_char(($1::timestamp AT TIME ZONE $3) AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
             to_char((NULLIF($2, '')::timestamp AT TIME ZONE $3) AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI') AS ends_local`,
          [draft.startsAtLocal, endsAtLocal ?? '', access.timezone],
        );
        const time = converted.rows[0];
        if (
          !time ||
          time.starts_local !== draft.startsAtLocal ||
          time.ends_local !== endsAtLocal ||
          time.starts_at.getTime() <= Date.now() ||
          (time.ends_at && time.ends_at <= time.starts_at)
        )
          throw new ApiError(
            400,
            'INVALID_TIME',
            'The event must start in the future and end after it starts. Check the household timezone.',
          );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO housemate.events (household_id, title, description, location, starts_at, ends_at, timezone, created_by_user_id, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            householdId,
            title,
            description,
            location,
            time.starts_at,
            time.ends_at,
            access.timezone,
            access.user_id,
            draft.idempotencyKey,
            hash,
          ],
        );
        id = inserted.rows[0]?.id;
        if (!id) throw new Error('Could not create event');
      }
      const event = await this.read(client, householdId, access.member_id, id);
      await client.query('COMMIT');
      if (!event) throw new Error('Could not read event');
      return event;
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
    eventId: string,
    response: EventResponse,
  ): Promise<HouseholdEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await this.access(client, authUserId, householdId);
      const result = await client.query<{ starts_at: Date }>(
        'SELECT starts_at FROM housemate.events WHERE household_id = $1 AND id = $2 FOR UPDATE',
        [householdId, eventId],
      );
      if (!result.rows[0])
        throw new ApiError(404, 'NOT_FOUND', 'Event not found.');
      if (result.rows[0].starts_at.getTime() <= Date.now())
        throw new ApiError(
          409,
          'EVENT_STARTED',
          'Attendance is closed because the event has started.',
        );
      await client.query(
        `INSERT INTO housemate.event_attendance (event_id, member_id, response)
         VALUES ($1,$2,$3)
         ON CONFLICT (event_id, member_id) DO UPDATE SET response = EXCLUDED.response, responded_at = now()`,
        [eventId, access.member_id, response],
      );
      const event = await this.read(
        client,
        householdId,
        access.member_id,
        eventId,
      );
      await client.query('COMMIT');
      if (!event) throw new Error('Could not read event');
      return event;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
