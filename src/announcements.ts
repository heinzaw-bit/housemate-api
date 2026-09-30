import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  type CommunicationAccess,
  checkActiveRecipients,
  futureLocalTime,
  normalizedMemberIds,
  withCommunicationAccess,
} from './communication-access.js';
import { ApiError } from './errors.js';

export type AnnouncementPriority = 'normal' | 'important' | 'urgent';
export type AnnouncementScope = 'all' | 'needs_ack' | 'expired';
export interface AnnouncementDraft {
  title: string;
  body: string;
  priority: AnnouncementPriority;
  requiresAcknowledgement: boolean;
  recipientIds: string[];
  expiresAtLocal?: string | null;
  idempotencyKey: string;
}
export interface Announcement {
  id: string;
  householdId: string;
  title: string;
  body: string;
  priority: AnnouncementPriority;
  requiresAcknowledgement: boolean;
  expiresAt: string | null;
  timezone: string;
  publishedAt: string;
  authorDisplayName: string;
  viewerMemberId: string;
  recipients: {
    memberId: string;
    displayName: string;
    active: boolean;
    acknowledgedAt: string | null;
  }[];
  counts: { total: number; acknowledged: number; awaiting: number };
  expired: boolean;
  canAcknowledge: boolean;
}
export interface AnnouncementRepository {
  list(
    authUserId: string,
    householdId: string,
    scope: AnnouncementScope,
    limit: number,
    offset: number,
  ): Promise<Announcement[]>;
  get(
    authUserId: string,
    householdId: string,
    announcementId: string,
  ): Promise<Announcement | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: AnnouncementDraft,
  ): Promise<Announcement>;
  acknowledge(
    authUserId: string,
    householdId: string,
    announcementId: string,
  ): Promise<Announcement>;
}

interface AnnouncementRow {
  id: string;
  household_id: string;
  title: string;
  body: string;
  priority: AnnouncementPriority;
  requires_acknowledgement: boolean;
  expires_at: Date | null;
  timezone: string;
  published_at: Date;
  author_display_name: string;
  expired: boolean;
}
const visibility = `(a.created_by_user_id = $2 OR $4::boolean OR EXISTS (
  SELECT 1 FROM housemate.announcement_recipients r WHERE r.announcement_id = a.id AND r.member_id = $3))`;

export class PgAnnouncementRepository implements AnnouncementRepository {
  constructor(private readonly pool: Pool) {}

  private async readMany(
    client: PoolClient,
    householdId: string,
    access: CommunicationAccess,
    ids: string[],
  ): Promise<Announcement[]> {
    if (!ids.length) return [];
    const records = await client.query<AnnouncementRow>(
      `SELECT a.*, u.display_name AS author_display_name,
         COALESCE(a.expires_at <= clock_timestamp(), false) AS expired
       FROM housemate.announcements a JOIN housemate.users u ON u.id = a.created_by_user_id
       WHERE a.household_id = $1 AND ${visibility} AND a.id = ANY($5::uuid[])`,
      [householdId, access.userId, access.memberId, access.moderator, ids],
    );
    const recipients = await client.query<{
      announcement_id: string;
      member_id: string;
      display_name: string;
      active: boolean;
      acknowledged_at: Date | null;
    }>(
      `SELECT r.announcement_id, r.member_id, u.display_name,
         m.status = 'active' AS active, r.acknowledged_at
       FROM housemate.announcement_recipients r
       JOIN housemate.household_members m ON m.id = r.member_id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE r.announcement_id = ANY($1::uuid[]) ORDER BY u.display_name, r.member_id`,
      [records.rows.map((record) => record.id)],
    );
    const mapped = new Map(
      records.rows.map((row) => {
        const people = recipients.rows
          .filter((person) => person.announcement_id === row.id)
          .map((person) => ({
            memberId: person.member_id,
            displayName: person.display_name,
            active: person.active,
            acknowledgedAt: person.acknowledged_at?.toISOString() ?? null,
          }));
        const mine = people.find(
          (person) => person.memberId === access.memberId,
        );
        return [
          row.id,
          {
            id: row.id,
            householdId: row.household_id,
            title: row.title,
            body: row.body,
            priority: row.priority,
            requiresAcknowledgement: row.requires_acknowledgement,
            expiresAt: row.expires_at?.toISOString() ?? null,
            timezone: row.timezone,
            publishedAt: row.published_at.toISOString(),
            authorDisplayName: row.author_display_name,
            viewerMemberId: access.memberId,
            recipients: people,
            counts: {
              total: people.length,
              acknowledged: people.filter(
                (person) => person.acknowledgedAt !== null,
              ).length,
              awaiting: row.requires_acknowledgement
                ? people.filter(
                    (person) => person.active && person.acknowledgedAt === null,
                  ).length
                : 0,
            },
            expired: row.expired,
            canAcknowledge:
              row.requires_acknowledgement &&
              !row.expired &&
              !!mine?.active &&
              mine.acknowledgedAt === null,
          } satisfies Announcement,
        ] as const;
      }),
    );
    return ids.flatMap((id) => {
      const record = mapped.get(id);
      return record ? [record] : [];
    });
  }

  async list(
    authUserId: string,
    householdId: string,
    scope: AnnouncementScope = 'all',
    limit = 50,
    offset = 0,
  ) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      false,
      async (client, access) => {
        const clause = {
          all: '',
          expired: 'AND a.expires_at <= now()',
          needs_ack: `AND a.requires_acknowledgement AND (a.expires_at IS NULL OR a.expires_at > now())
          AND EXISTS (SELECT 1 FROM housemate.announcement_recipients r
            WHERE r.announcement_id = a.id AND r.member_id = $3 AND r.acknowledged_at IS NULL)`,
        }[scope];
        const result = await client.query<{ id: string }>(
          `SELECT a.id FROM housemate.announcements a
         WHERE a.household_id = $1 AND ${visibility} ${clause}
         ORDER BY COALESCE(a.expires_at <= now(), false),
           CASE a.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
           a.published_at DESC, a.id DESC LIMIT $5 OFFSET $6`,
          [
            householdId,
            access.userId,
            access.memberId,
            access.moderator,
            limit,
            offset,
          ],
        );
        return this.readMany(
          client,
          householdId,
          access,
          result.rows.map((row) => row.id),
        );
      },
    );
  }

  async get(authUserId: string, householdId: string, announcementId: string) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      false,
      async (client, access) =>
        (
          await this.readMany(client, householdId, access, [announcementId])
        )[0] ?? null,
    );
  }

  async create(
    authUserId: string,
    householdId: string,
    draft: AnnouncementDraft,
  ) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      true,
      async (client, access) => {
        const title = draft.title.trim();
        const body = draft.body.trim();
        const recipientIds = normalizedMemberIds(draft.recipientIds);
        const expiresAtLocal = draft.expiresAtLocal || null;
        if (
          !title ||
          title.length > 160 ||
          !body ||
          body.length > 4000 ||
          !['normal', 'important', 'urgent'].includes(draft.priority)
        )
          throw new ApiError(
            400,
            'INVALID_ANNOUNCEMENT',
            'Enter a title, message, and valid priority.',
          );
        const hash = createHash('sha256')
          .update(
            JSON.stringify({
              title,
              body,
              priority: draft.priority,
              requiresAcknowledgement: draft.requiresAcknowledgement,
              recipientIds,
              expiresAtLocal,
            }),
          )
          .digest('hex');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            `announcement:${householdId}:${access.userId}:${draft.idempotencyKey}`,
          ],
        );
        const prior = await client.query<{ id: string; request_hash: string }>(
          `SELECT id, request_hash FROM housemate.announcements
         WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
          [householdId, access.userId, draft.idempotencyKey],
        );
        let id = prior.rows[0]?.id;
        if (id && prior.rows[0]?.request_hash !== hash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This publication key was already used for different details.',
          );
        if (!id) {
          await checkActiveRecipients(client, householdId, recipientIds);
          const expiresAt = expiresAtLocal
            ? await futureLocalTime(client, expiresAtLocal, access.timezone)
            : null;
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO housemate.announcements (household_id, title, body, priority, requires_acknowledgement, expires_at, timezone, created_by_user_id, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [
              householdId,
              title,
              body,
              draft.priority,
              draft.requiresAcknowledgement,
              expiresAt,
              access.timezone,
              access.userId,
              draft.idempotencyKey,
              hash,
            ],
          );
          id = inserted.rows[0]?.id;
          if (!id) throw new Error('Could not publish announcement');
          await client.query(
            `INSERT INTO housemate.announcement_recipients (announcement_id, member_id)
           SELECT $1::uuid, member_id FROM unnest($2::uuid[]) AS member_id`,
            [id, recipientIds],
          );
        }
        const record = (
          await this.readMany(client, householdId, access, [id])
        )[0];
        if (!record) throw new Error('Could not read announcement');
        return record;
      },
    );
  }

  async acknowledge(
    authUserId: string,
    householdId: string,
    announcementId: string,
  ) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      true,
      async (client, access) => {
        const locked = await client.query<{
          requires_acknowledgement: boolean;
          expires_at: Date | null;
        }>(
          `SELECT requires_acknowledgement, expires_at FROM housemate.announcements
         WHERE household_id = $1 AND id = $2 FOR UPDATE`,
          [householdId, announcementId],
        );
        const announcement = locked.rows[0];
        if (!announcement)
          throw new ApiError(404, 'NOT_FOUND', 'Announcement not found.');
        const recipient = await client.query<{ acknowledged_at: Date | null }>(
          'SELECT acknowledged_at FROM housemate.announcement_recipients WHERE announcement_id = $1 AND member_id = $2',
          [announcementId, access.memberId],
        );
        if (!recipient.rows[0])
          throw new ApiError(
            403,
            'NOT_RECIPIENT',
            'Only selected recipients can acknowledge this announcement.',
          );
        if (recipient.rows[0].acknowledged_at === null) {
          if (!announcement.requires_acknowledgement)
            throw new ApiError(
              409,
              'ACK_NOT_REQUIRED',
              'This announcement does not request acknowledgement.',
            );
          const expiry = await client.query<{ expired: boolean }>(
            'SELECT COALESCE($1::timestamptz <= clock_timestamp(), false) AS expired',
            [announcement.expires_at],
          );
          if (expiry.rows[0]?.expired)
            throw new ApiError(
              409,
              'ANNOUNCEMENT_EXPIRED',
              'This announcement has expired.',
            );
          await client.query(
            `UPDATE housemate.announcement_recipients SET acknowledged_at = clock_timestamp()
           WHERE announcement_id = $1 AND member_id = $2 AND acknowledged_at IS NULL`,
            [announcementId, access.memberId],
          );
        }
        const record = (
          await this.readMany(client, householdId, access, [announcementId])
        )[0];
        if (!record) throw new Error('Could not read announcement');
        return record;
      },
    );
  }
}
