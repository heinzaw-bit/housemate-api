import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { UUID_PATTERN } from './auth.js';
import { withCommunicationAccess } from './communication-access.js';
import { ApiError } from './errors.js';
import { notificationHref } from './notifications.js';

export const searchTypes = [
  'expense',
  'bill',
  'settlement',
  'meal',
  'chore',
  'shopping',
  'event',
  'announcement',
  'poll',
] as const;
export type SearchType = (typeof searchTypes)[number];
export interface SearchInput {
  q: string;
  type?: SearchType | 'all';
  limit?: number;
  cursor?: string;
}
export interface SearchHit {
  id: string;
  type: SearchType;
  title: string;
  snippet: string;
  status: string;
  createdAt: string;
  href: string;
}
export interface SearchPage {
  results: SearchHit[];
  nextCursor: string | null;
}
export interface SearchRepository {
  search(
    user: string,
    household: string,
    input: SearchInput,
  ): Promise<SearchPage>;
}
interface Cursor {
  scope: string;
  date: string;
  type: SearchType;
  id: string;
}
interface SearchRow {
  id: string;
  type: SearchType;
  title: string;
  snippet: string;
  status: string;
  created_at: string;
}

export function searchPattern(q: string) {
  return `%${q.replace(/[!%_]/g, (character) => `!${character}`)}%`;
}
export function normalizeSearch(input: SearchInput) {
  const q = input.q.trim();
  const type = input.type ?? 'all';
  const limit = input.limit ?? 20;
  if (
    q.length < 2 ||
    q.length > 120 ||
    q.includes('\0') ||
    (type !== 'all' && !searchTypes.includes(type)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new ApiError(
      400,
      'INVALID_SEARCH',
      'Enter 2–120 characters and choose a valid record type.',
    );
  return { q, type, limit };
}
function invalidCursor(): never {
  throw new ApiError(
    400,
    'INVALID_CURSOR',
    'Start a new search; this continuation is invalid.',
  );
}
export function decodeSearchCursor(value: string, scope: string): Cursor {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    return invalidCursor();
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Cursor;
    if (
      !cursor ||
      cursor.scope !== scope ||
      !searchTypes.includes(cursor.type) ||
      typeof cursor.id !== 'string' ||
      !UUID_PATTERN.test(cursor.id) ||
      typeof cursor.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.date)
    )
      return invalidCursor();
    const parsed = new Date(cursor.date);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 23) !== cursor.date.slice(0, 23)
    )
      return invalidCursor();
    return cursor;
  } catch {
    return invalidCursor();
  }
}

// Each branch starts from the household's indexed foreign key. Targeted communication
// access is applied before matching, snippets, pagination or visibility metadata.
const sources: Record<SearchType, string> = {
  expense: `SELECT e.id, 'expense'::text AS type, e.title, ''::text AS description,
    CASE WHEN e.voided_at IS NULL THEN 'confirmed' ELSE 'voided' END AS status, e.created_at
    FROM housemate.expenses e WHERE e.household_id = $1`,
  bill: `SELECT b.id, 'bill'::text AS type, b.title, b.provider AS description,
    CASE WHEN b.voided_at IS NULL THEN b.payment_status ELSE 'voided' END AS status, b.created_at
    FROM housemate.bills b WHERE b.household_id = $1`,
  settlement: `SELECT s.id, 'settlement'::text AS type, su.display_name || ' → ' || ru.display_name AS title,
    concat_ws(' · ', s.method, s.note) AS description, 'recorded'::text AS status, s.created_at
    FROM housemate.settlements s
    JOIN housemate.household_members sm ON sm.id = s.sender_member_id AND sm.household_id = s.household_id
    JOIN housemate.users su ON su.id = sm.user_id
    JOIN housemate.household_members rm ON rm.id = s.recipient_member_id AND rm.household_id = s.household_id
    JOIN housemate.users ru ON ru.id = rm.user_id WHERE s.household_id = $1`,
  meal: `SELECT m.id, 'meal'::text AS type, m.question AS title, m.meal_type AS description,
    CASE WHEN m.starts_at <= now() THEN 'past' ELSE 'upcoming' END AS status, m.created_at
    FROM housemate.meal_checks m WHERE m.household_id = $1`,
  chore: `SELECT c.id, 'chore'::text AS type, c.title, coalesce(c.note, '') AS description, c.status, c.created_at
    FROM housemate.chores c WHERE c.household_id = $1`,
  shopping: `SELECT s.id, 'shopping'::text AS type, s.title, concat_ws(' · ', s.note, s.unit) AS description, s.status, s.created_at
    FROM housemate.shopping_items s WHERE s.household_id = $1`,
  event: `SELECT e.id, 'event'::text AS type, e.title, concat_ws(' · ', e.description, e.location) AS description,
    CASE WHEN e.starts_at <= now() THEN 'past' ELSE 'upcoming' END AS status, e.created_at
    FROM housemate.events e WHERE e.household_id = $1`,
  announcement: `SELECT a.id, 'announcement'::text AS type, a.title, a.body AS description,
    CASE WHEN a.expires_at <= now() THEN 'expired' ELSE a.priority END AS status, a.published_at AS created_at
    FROM housemate.announcements a WHERE a.household_id = $1
    AND (a.created_by_user_id = $3 OR $5::boolean OR EXISTS (SELECT 1 FROM housemate.announcement_recipients r WHERE r.announcement_id = a.id AND r.member_id = $4))`,
  poll: `SELECT p.id, 'poll'::text AS type, p.question AS title,
    coalesce((SELECT string_agg(o.label, ' · ' ORDER BY o.position) FROM housemate.poll_options o WHERE o.poll_id = p.id), '') AS description,
    CASE WHEN p.deadline <= now() THEN 'closed' ELSE 'open' END AS status, p.created_at
    FROM housemate.polls p WHERE p.household_id = $1
    AND (p.created_by_user_id = $3 OR $5::boolean OR EXISTS (SELECT 1 FROM housemate.poll_voters v WHERE v.poll_id = p.id AND v.member_id = $4))`,
};

export class PgSearchRepository implements SearchRepository {
  constructor(private readonly pool: Pool) {}
  async search(
    user: string,
    household: string,
    input: SearchInput,
  ): Promise<SearchPage> {
    const { q, type, limit } = normalizeSearch(input);
    const scope = createHash('sha256')
      .update(JSON.stringify([user, household, q, type]))
      .digest('hex');
    const cursor = input.cursor
      ? decodeSearchCursor(input.cursor, scope)
      : null;
    try {
      return await withCommunicationAccess(
        this.pool,
        user,
        household,
        false,
        async (client, access) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          const union = (type === 'all' ? searchTypes : [type])
            .map((kind) => sources[kind])
            .join('\nUNION ALL\n');
          const page = await client.query<SearchRow>(
            `WITH viewer AS (SELECT $3::uuid AS user_id, $4::uuid AS member_id, $5::boolean AS moderator), records AS (${union})
          SELECT id, type, left(title, 240) AS title, left(description, 180) AS snippet, status,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
          FROM records WHERE (title ILIKE $2 ESCAPE '!' OR description ILIKE $2 ESCAPE '!')
            AND ($6::timestamptz IS NULL OR (created_at, type COLLATE "C", id) < ($6::timestamptz, $7::text COLLATE "C", $8::uuid))
          ORDER BY records.created_at DESC, type COLLATE "C" DESC, id DESC LIMIT $9`,
            [
              household,
              searchPattern(q),
              access.userId,
              access.memberId,
              access.moderator,
              cursor?.date ?? null,
              cursor?.type ?? null,
              cursor?.id ?? null,
              limit + 1,
            ],
          );
          const rows = page.rows.slice(0, limit);
          const last = rows.at(-1);
          return {
            results: rows.map((row) => ({
              id: row.id,
              type: row.type,
              title: row.title,
              snippet: row.snippet,
              status: row.status,
              createdAt: row.created_at,
              href: notificationHref(household, row.type, row.id),
            })),
            nextCursor:
              page.rows.length > limit && last
                ? Buffer.from(
                    JSON.stringify({
                      scope,
                      date: last.created_at,
                      type: last.type,
                      id: last.id,
                    } satisfies Cursor),
                  ).toString('base64url')
                : null,
          };
        },
      );
    } catch (cause) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === '57014'
      )
        throw new ApiError(
          503,
          'SEARCH_TIMEOUT',
          'Search took too long. Try a more specific phrase or record type.',
        );
      throw cause;
    }
  }
}
