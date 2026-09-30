import { ECDH } from 'node:crypto';
import type { Pool } from 'pg';
import { UUID_PATTERN } from './auth.js';
import { withCommunicationAccess } from './communication-access.js';
import { ApiError } from './errors.js';

export const notificationCategories = [
  'money',
  'bills',
  'settlements',
  'meals',
  'chores',
  'shopping',
  'events',
  'announcements',
  'polls',
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export type NotificationEntity =
  | 'expense'
  | 'bill'
  | 'settlement'
  | 'meal'
  | 'chore'
  | 'shopping'
  | 'event'
  | 'announcement'
  | 'poll';
export interface NotificationItem {
  id: string;
  householdId: string;
  category: NotificationCategory;
  priority: string;
  entityType: NotificationEntity;
  entityId: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  href: string;
}
export interface NotificationPage {
  notifications: NotificationItem[];
  unreadCount: number;
  nextCursor: string | null;
}
export interface NotificationPreferences {
  categories: Record<
    NotificationCategory,
    { inApp: boolean; webPush: boolean }
  >;
  quietHours: { enabled: boolean; start: string; end: string };
  timezone: string;
}
export interface PushRegistration {
  endpoint: string;
  refreshOnly?: boolean;
  keys: { p256dh: string; auth: string };
}
export interface PushDevice {
  id: string;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}
export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  reason: 'server_setup' | null;
}
export interface NotificationRepository {
  list(
    user: string,
    household: string,
    scope: 'all' | 'unread',
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage>;
  markRead(user: string, household: string, id: string): Promise<void>;
  markAllRead(user: string, household: string, through: string): Promise<void>;
  preferences(
    user: string,
    household: string,
  ): Promise<NotificationPreferences>;
  savePreferences(
    user: string,
    household: string,
    input: Omit<NotificationPreferences, 'timezone'>,
  ): Promise<NotificationPreferences>;
  devices(user: string): Promise<PushDevice[]>;
  subscribe(user: string, input: PushRegistration): Promise<PushDevice>;
  unsubscribe(user: string, id: string): Promise<void>;
}

export function notificationHref(
  householdId: string,
  type: NotificationEntity,
  id: string,
): string {
  const query = new URLSearchParams({ household: householdId });
  if (['expense', 'bill', 'settlement'].includes(type)) {
    query.set(
      'view',
      type === 'expense' ? 'expenses' : type === 'bill' ? 'bills' : 'balances',
    );
    query.set('record', id);
    return `/money?${query}`;
  }
  const section = {
    meal: 'meals',
    chore: 'chores',
    shopping: 'shopping',
    event: 'events',
    announcement: 'announcements',
    poll: 'polls',
  }[type as 'meal'];
  query.set('view', section);
  query.set(type === 'shopping' ? 'item' : type, id);
  return `/house?${query}`;
}
export function defaultNotificationPreferences(
  timezone: string,
): NotificationPreferences {
  return {
    categories: Object.fromEntries(
      notificationCategories.map((category) => [
        category,
        { inApp: true, webPush: category !== 'shopping' },
      ]),
    ) as NotificationPreferences['categories'],
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    timezone,
  };
}
export function validateNotificationPreferences(
  input: Omit<NotificationPreferences, 'timezone'>,
): void {
  if (
    Object.keys(input.categories).length !== notificationCategories.length ||
    notificationCategories.some(
      (category) =>
        typeof input.categories[category]?.inApp !== 'boolean' ||
        typeof input.categories[category]?.webPush !== 'boolean',
    )
  )
    throw new ApiError(
      400,
      'INVALID_PREFERENCES',
      'Set both channels for every notification category.',
    );
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietHours.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietHours.end) ||
    input.quietHours.start === input.quietHours.end
  )
    throw new ApiError(
      400,
      'INVALID_PREFERENCES',
      'Choose different valid start and end times for quiet hours.',
    );
}
export function validatePushRegistration(input: PushRegistration): void {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new ApiError(
      400,
      'INVALID_SUBSCRIPTION',
      'Invalid browser push endpoint.',
    );
  }
  const allowed =
    [
      'fcm.googleapis.com',
      'fcmandroid.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
    ].includes(endpoint.hostname) ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(endpoint.hostname);
  if (
    !allowed ||
    endpoint.protocol !== 'https:' ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    input.endpoint.length > 2048
  )
    throw new ApiError(
      400,
      'INVALID_SUBSCRIPTION',
      'Use a subscription from a supported browser push service.',
    );
  try {
    if (
      !/^[A-Za-z0-9_-]+$/.test(input.keys.p256dh) ||
      !/^[A-Za-z0-9_-]+$/.test(input.keys.auth)
    )
      throw Error('encoding');
    const key = Buffer.from(input.keys.p256dh, 'base64url');
    if (
      key.length !== 65 ||
      key[0] !== 4 ||
      Buffer.from(input.keys.auth, 'base64url').length !== 16
    )
      throw Error('length');
    ECDH.convertKey(key, 'prime256v1');
  } catch {
    throw new ApiError(
      400,
      'INVALID_SUBSCRIPTION',
      'Invalid browser push encryption keys.',
    );
  }
}

interface NotificationRow {
  id: string;
  household_id: string;
  category: NotificationCategory;
  priority: string;
  entity_type: NotificationEntity;
  entity_id: string;
  title: string;
  body: string;
  created_at: Date;
  cursor_time: string;
  read_at: Date | null;
}
function mapDevice(row: {
  id: string;
  enabled: boolean;
  created_at: Date;
  last_sent_at: Date | null;
  last_error: string | null;
}): PushDevice {
  return {
    id: row.id,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    lastSentAt: row.last_sent_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

export class PgNotificationRepository implements NotificationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly push: PushConfig,
  ) {}
  async list(
    user: string,
    household: string,
    scope: 'all' | 'unread',
    limit: number,
    cursor?: string,
  ) {
    let before: { time: string; id: string } | null = null;
    if (cursor) {
      try {
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !before ||
          typeof before.id !== 'string' ||
          !UUID_PATTERN.test(before.id) ||
          typeof before.time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(before.time) ||
          Number.isNaN(Date.parse(before.time))
        )
          throw Error('cursor');
      } catch {
        throw new ApiError(
          400,
          'INVALID_CURSOR',
          'Invalid notification page cursor.',
        );
      }
    }
    return withCommunicationAccess(
      this.pool,
      user,
      household,
      false,
      async (client, access) => {
        const records = await client.query<NotificationRow>(
          `SELECT n.*, to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM housemate.notifications n
        WHERE n.household_id=$1 AND n.member_id=$2 AND n.in_app AND ($3::boolean=false OR n.read_at IS NULL)
        AND ($4::timestamptz IS NULL OR (n.created_at,n.id)<($4::timestamptz,$5::uuid))
        ORDER BY n.created_at DESC,n.id DESC LIMIT $6`,
          [
            household,
            access.memberId,
            scope === 'unread',
            before?.time ?? null,
            before?.id ?? null,
            limit + 1,
          ],
        );
        const count = await client.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM housemate.notifications WHERE household_id=$1 AND member_id=$2 AND in_app AND read_at IS NULL',
          [household, access.memberId],
        );
        const rows = records.rows.slice(0, limit);
        const last = rows.at(-1);
        return {
          notifications: rows.map((row) => ({
            id: row.id,
            householdId: row.household_id,
            category: row.category,
            priority: row.priority,
            entityType: row.entity_type,
            entityId: row.entity_id,
            title: row.title,
            body: row.body,
            createdAt: row.created_at.toISOString(),
            readAt: row.read_at?.toISOString() ?? null,
            href: notificationHref(household, row.entity_type, row.entity_id),
          })),
          unreadCount: count.rows[0]?.count ?? 0,
          nextCursor:
            records.rows.length > limit && last
              ? Buffer.from(
                  JSON.stringify({
                    time: last.cursor_time,
                    id: last.id,
                  }),
                ).toString('base64url')
              : null,
        };
      },
    );
  }
  async markRead(user: string, household: string, id: string) {
    return withCommunicationAccess(
      this.pool,
      user,
      household,
      true,
      async (client, access) => {
        const updated = await client.query(
          'UPDATE housemate.notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND household_id=$2 AND member_id=$3 AND in_app RETURNING id',
          [id, household, access.memberId],
        );
        if (!updated.rowCount)
          throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
      },
    );
  }
  async markAllRead(user: string, household: string, through: string) {
    return withCommunicationAccess(
      this.pool,
      user,
      household,
      true,
      async (client, access) => {
        const boundary = await client.query<{ created_at: Date }>(
          'SELECT created_at FROM housemate.notifications WHERE id=$1 AND household_id=$2 AND member_id=$3 AND in_app',
          [through, household, access.memberId],
        );
        if (!boundary.rows[0])
          throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
        await client.query(
          `UPDATE housemate.notifications SET read_at=clock_timestamp() WHERE household_id=$1 AND member_id=$2 AND in_app AND read_at IS NULL
        AND (created_at,id)<=(SELECT created_at,id FROM housemate.notifications WHERE id=$3::uuid)`,
          [household, access.memberId, through],
        );
      },
    );
  }
  async preferences(user: string, household: string) {
    return withCommunicationAccess(
      this.pool,
      user,
      household,
      false,
      async (client, access) => {
        const saved = await client.query<{
          categories: NotificationPreferences['categories'];
          quiet_enabled: boolean;
          quiet_start: string;
          quiet_end: string;
        }>(
          'SELECT * FROM housemate.notification_preferences WHERE member_id=$1',
          [access.memberId],
        );
        const row = saved.rows[0];
        const result = defaultNotificationPreferences(access.timezone);
        if (row) {
          result.categories = { ...result.categories, ...row.categories };
          result.quietHours = {
            enabled: row.quiet_enabled,
            start: row.quiet_start.slice(0, 5),
            end: row.quiet_end.slice(0, 5),
          };
        }
        return result;
      },
    );
  }
  async savePreferences(
    user: string,
    household: string,
    input: Omit<NotificationPreferences, 'timezone'>,
  ) {
    validateNotificationPreferences(input);
    return withCommunicationAccess(
      this.pool,
      user,
      household,
      true,
      async (client, access) => {
        await client.query(
          `INSERT INTO housemate.notification_preferences (member_id,categories,quiet_enabled,quiet_start,quiet_end)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (member_id) DO UPDATE SET categories=EXCLUDED.categories,quiet_enabled=EXCLUDED.quiet_enabled,
        quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,updated_at=now()`,
          [
            access.memberId,
            JSON.stringify(input.categories),
            input.quietHours.enabled,
            input.quietHours.start,
            input.quietHours.end,
          ],
        );
        return { ...input, timezone: access.timezone };
      },
    );
  }
  private async userId(authUserId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM housemate.users WHERE auth_user_id=$1',
      [authUserId],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    return id;
  }
  async devices(user: string) {
    const userId = await this.userId(user);
    return (
      await this.pool.query(
        'SELECT id,enabled,created_at,last_sent_at,last_error FROM housemate.push_subscriptions WHERE user_id=$1 ORDER BY created_at DESC',
        [userId],
      )
    ).rows.map(mapDevice);
  }
  async subscribe(user: string, input: PushRegistration) {
    if (!this.push.enabled || !this.push.publicKey)
      throw new ApiError(
        503,
        'PUSH_NOT_CONFIGURED',
        'Web push needs a server contact address and VAPID setup.',
      );
    validatePushRegistration(input);
    const userId = await this.userId(user);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM housemate.users WHERE id=$1 FOR UPDATE',
        [userId],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [input.endpoint],
      );
      const prior = await client.query<{ user_id: string; enabled: boolean }>(
        'SELECT user_id,enabled FROM housemate.push_subscriptions WHERE endpoint=$1 FOR UPDATE',
        [input.endpoint],
      );
      if (prior.rows[0] && prior.rows[0].user_id !== userId)
        throw new ApiError(
          409,
          'DEVICE_ACCOUNT_CONFLICT',
          'This browser subscription belongs to another account. Disable it in this browser, then enable again.',
        );
      const count = await client.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM housemate.push_subscriptions WHERE user_id=$1 AND enabled',
        [userId],
      );
      if (input.refreshOnly && !prior.rows[0]?.enabled)
        throw new ApiError(
          409,
          'DEVICE_DISABLED',
          'Enable this browser explicitly to register a new or disabled subscription.',
        );
      if (!prior.rows[0]?.enabled && (count.rows[0]?.count ?? 0) >= 10)
        throw new ApiError(
          409,
          'DEVICE_LIMIT',
          'Disable an older push device before adding another.',
        );
      const saved = await client.query(
        `INSERT INTO housemate.push_subscriptions (user_id,endpoint,p256dh,auth,vapid_public_key)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,
        vapid_public_key=EXCLUDED.vapid_public_key,enabled=true,enabled_at=CASE WHEN housemate.push_subscriptions.enabled THEN housemate.push_subscriptions.enabled_at ELSE now() END,
        refreshed_at=now(),last_error=NULL RETURNING id,enabled,created_at,last_sent_at,last_error`,
        [
          userId,
          input.endpoint,
          input.keys.p256dh,
          input.keys.auth,
          this.push.publicKey,
        ],
      );
      await client.query('COMMIT');
      return mapDevice(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async unsubscribe(user: string, id: string) {
    const userId = await this.userId(user);
    const result = await this.pool.query(
      'UPDATE housemate.push_subscriptions SET enabled=false WHERE id=$1 AND user_id=$2 RETURNING id',
      [id, userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, 'NOT_FOUND', 'Push device not found.');
  }
}
