import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import webpush from 'web-push';
import {
  type NotificationEntity,
  notificationHref,
  validatePushRegistration,
} from './notifications.js';

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}
export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  ttl: number,
  urgency?: 'normal' | 'high',
) => Promise<void>;
export function createPushSender(config: VapidConfig): PushSender {
  return async (subscription, payload, ttl, urgency = 'normal') => {
    await webpush.sendNotification(subscription, payload, {
      vapidDetails: config,
      TTL: ttl,
      urgency,
      timeout: 10_000,
      topic: (JSON.parse(payload) as { id: string }).id.replace(/-/g, ''),
    });
  };
}
export function pushUrgency(
  priority: string,
  kind: string,
  expires: Date,
  now = Date.now(),
): 'normal' | 'high' {
  return priority === 'urgent' ||
    (kind === 'reminder' && expires.getTime() - now <= 30 * 60_000)
    ? 'high'
    : 'normal';
}
export function isQuietTime(time: string, start: string, end: string): boolean {
  return start < end
    ? time >= start && time < end
    : time >= start || time < end;
}
export function pushErrorOutcome(
  status: number | undefined,
  attempts: number,
): 'invalid' | 'failed' | 'pending' {
  if (status === 404 || status === 410) return 'invalid';
  if (attempts >= 5 || (status !== undefined && status < 500 && status !== 429))
    return 'failed';
  return 'pending';
}
export function privatePushPayload(id: string, href: string): string {
  return JSON.stringify({
    id,
    title: 'HouseMate',
    body: 'You have a household update. Open HouseMate to see it.',
    href,
  });
}

// Recheck source state at delivery, so answered, paid, closed, or expired reminders are skipped.
const actionable = `CASE n.entity_type
 WHEN 'bill' THEN EXISTS (SELECT 1 FROM housemate.bills b WHERE b.id=n.entity_id AND b.household_id=n.household_id AND (n.kind<>'reminder' OR (b.payment_status='unpaid' AND b.voided_at IS NULL AND EXISTS (SELECT 1 FROM housemate.bill_shares bs WHERE bs.bill_id=b.id AND bs.member_id=n.member_id))))
 WHEN 'expense' THEN EXISTS (SELECT 1 FROM housemate.expenses e WHERE e.id=n.entity_id AND e.household_id=n.household_id)
 WHEN 'settlement' THEN EXISTS (SELECT 1 FROM housemate.settlements s WHERE s.id=n.entity_id AND s.household_id=n.household_id AND n.member_id IN (s.sender_member_id,s.recipient_member_id))
 WHEN 'meal' THEN EXISTS (SELECT 1 FROM housemate.meal_checks mc JOIN housemate.meal_participants mp ON mp.meal_id=mc.id AND mp.member_id=n.member_id WHERE mc.id=n.entity_id AND mc.household_id=n.household_id AND CASE WHEN n.kind='cooking_role' THEN mc.starts_at>now() AND EXISTS(SELECT 1 FROM housemate.meal_cooking_roles cr WHERE cr.meal_id=mc.id AND cr.member_id=n.member_id) ELSE mc.response_deadline>now() AND mp.response IS NULL END)
 WHEN 'chore' THEN EXISTS (SELECT 1 FROM housemate.chores c WHERE c.id=n.entity_id AND c.household_id=n.household_id AND (n.kind NOT IN ('reminder','assigned') OR (c.status='open' AND c.assignee_member_id=n.member_id)))
 WHEN 'shopping' THEN EXISTS (SELECT 1 FROM housemate.shopping_items s WHERE s.id=n.entity_id AND s.household_id=n.household_id)
 WHEN 'event' THEN EXISTS (SELECT 1 FROM housemate.events e LEFT JOIN housemate.event_attendance a ON a.event_id=e.id AND a.member_id=n.member_id WHERE e.id=n.entity_id AND e.household_id=n.household_id AND e.starts_at>now() AND (a.response IS NULL OR a.response<>'not_going'))
 WHEN 'announcement' THEN EXISTS (SELECT 1 FROM housemate.announcements a JOIN housemate.announcement_recipients r ON r.announcement_id=a.id AND r.member_id=n.member_id WHERE a.id=n.entity_id AND a.household_id=n.household_id AND (a.expires_at IS NULL OR a.expires_at>now()) AND (NOT a.requires_acknowledgement OR r.acknowledged_at IS NULL))
 WHEN 'poll' THEN EXISTS (SELECT 1 FROM housemate.polls p JOIN housemate.poll_voters pv ON pv.poll_id=p.id AND pv.member_id=n.member_id WHERE p.id=n.entity_id AND p.household_id=n.household_id AND p.deadline>now() AND NOT EXISTS (SELECT 1 FROM housemate.poll_votes v WHERE v.poll_id=p.id AND v.member_id=n.member_id))
 ELSE false END`;

interface Delivery {
  notification_id: string;
  subscription_id: string;
  attempts: number;
  lease_id: string;
}
interface DeliveryContext {
  endpoint: string;
  p256dh: string;
  auth: string;
  household_id: string;
  entity_type: NotificationEntity;
  entity_id: string;
  expires_at: Date;
  allowed: boolean;
  quiet: boolean;
  resume_at: Date;
  priority: string;
  kind: string;
}
export class NotificationWorker {
  private running = false;
  constructor(
    private readonly pool: Pool,
    private readonly sender: PushSender | null,
    private readonly publicKey: string | null,
  ) {}
  async tick(): Promise<void> {
    const deadline = Date.now() + 20_000;
    if (this.running) return;
    this.running = true;
    try {
      await this.pool.query(
        'SELECT housemate.generate_notification_reminders()',
      );
      if (!this.sender || !this.publicKey) return;
      await this.pool.query(
        `INSERT INTO housemate.push_deliveries (notification_id,subscription_id)
        SELECT n.id,s.id FROM housemate.notifications n JOIN housemate.household_members m ON m.id=n.member_id AND m.household_id=n.household_id
        JOIN housemate.households h ON h.id=n.household_id
        JOIN housemate.push_subscriptions s ON s.user_id=m.user_id
        WHERE n.push_requested AND n.read_at IS NULL AND n.expires_at>now() AND m.status='active' AND h.archived_at IS NULL
          AND s.enabled AND s.vapid_public_key=$1 AND n.created_at>=s.enabled_at AND n.created_at>=m.joined_at
        ON CONFLICT DO NOTHING`,
        [this.publicKey],
      );
      for (
        let processed = 0;
        processed < 200 && Date.now() < deadline - 10_000;
        processed += 4
      ) {
        const claimed = await this.pool.query<Delivery>(
          `WITH ready AS (
        SELECT notification_id,subscription_id FROM housemate.push_deliveries WHERE (status='pending' AND available_at<=now())
          OR (status='processing' AND leased_until<now()) ORDER BY available_at LIMIT 4 FOR UPDATE SKIP LOCKED)
        UPDATE housemate.push_deliveries d SET status='processing',lease_id=$1,leased_until=now()+interval '2 minutes',attempts=d.attempts+1,last_attempt_at=now()
        FROM ready WHERE d.notification_id=ready.notification_id AND d.subscription_id=ready.subscription_id RETURNING d.*`,
          [randomUUID()],
        );
        if (!claimed.rows.length) break;
        await Promise.all(claimed.rows.map((job) => this.deliver(job)));
      }
    } finally {
      this.running = false;
    }
  }
  private async deliver(job: Delivery): Promise<void> {
    const context = await this.pool.query<DeliveryContext>(
      `SELECT n.household_id,n.entity_type,n.entity_id,n.expires_at,n.priority,n.kind,s.endpoint,s.p256dh,s.auth,
      s.enabled AND s.vapid_public_key=$3 AND m.status='active' AND h.archived_at IS NULL AND n.created_at>=m.joined_at AND n.created_at>=s.enabled_at
        AND n.read_at IS NULL AND n.expires_at>now() AND COALESCE((p.categories->n.category->>'webPush')::boolean,n.category<>'shopping') AND (${actionable}) AS allowed,
      COALESCE(p.quiet_enabled,false) AND CASE WHEN p.quiet_start<p.quiet_end THEN (now() AT TIME ZONE h.timezone)::time>=p.quiet_start AND (now() AT TIME ZONE h.timezone)::time<p.quiet_end
        ELSE (now() AT TIME ZONE h.timezone)::time>=p.quiet_start OR (now() AT TIME ZONE h.timezone)::time<p.quiet_end END AS quiet,
      (((now() AT TIME ZONE h.timezone)::date + COALESCE(p.quiet_end,'07:00'::time)) + CASE WHEN p.quiet_start>p.quiet_end AND (now() AT TIME ZONE h.timezone)::time>=p.quiet_start THEN interval '1 day' ELSE interval '0 days' END) AT TIME ZONE h.timezone AS resume_at
      FROM housemate.notifications n JOIN housemate.household_members m ON m.id=n.member_id AND m.household_id=n.household_id
      JOIN housemate.households h ON h.id=n.household_id
      JOIN housemate.push_subscriptions s ON s.id=$2 AND s.user_id=m.user_id
      LEFT JOIN housemate.notification_preferences p ON p.member_id=m.id WHERE n.id=$1`,
      [job.notification_id, job.subscription_id, this.publicKey],
    );
    const row = context.rows[0];
    if (!row?.allowed) {
      await this.finish(job, 'skipped');
      return;
    }
    if (row.quiet) {
      await this.pool.query(
        `UPDATE housemate.push_deliveries SET status='pending',available_at=$4,attempts=GREATEST(attempts-1,0),leased_until=NULL
        WHERE notification_id=$1 AND subscription_id=$2 AND lease_id=$3`,
        [job.notification_id, job.subscription_id, job.lease_id, row.resume_at],
      );
      return;
    }
    try {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      validatePushRegistration(subscription);
      const ttl = Math.max(
        1,
        Math.min(
          3600,
          Math.floor((row.expires_at.getTime() - Date.now()) / 1000),
        ),
      );
      if (!this.sender) return;
      await this.sender(
        subscription,
        privatePushPayload(
          job.notification_id,
          notificationHref(row.household_id, row.entity_type, row.entity_id),
        ),
        ttl,
        pushUrgency(row.priority, row.kind, row.expires_at),
      );
      await this.finish(job, 'sent');
      await this.pool.query(
        'UPDATE housemate.push_subscriptions SET last_sent_at=now(),last_error=NULL WHERE id=$1',
        [job.subscription_id],
      );
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode)
          : undefined;
      const outcome = pushErrorOutcome(status, job.attempts);
      const safeError =
        status !== undefined && Number.isFinite(status)
          ? `HTTP_${status}`
          : 'DELIVERY_FAILED';
      await this.finish(job, outcome, safeError);
      await this.pool.query(
        `UPDATE housemate.push_subscriptions SET last_error=$2,enabled=CASE WHEN $3='invalid' THEN false ELSE enabled END WHERE id=$1`,
        [job.subscription_id, safeError, outcome],
      );
    }
  }
  private async finish(
    job: Delivery,
    status: string,
    error: string | null = null,
  ) {
    await this.pool.query(
      `UPDATE housemate.push_deliveries SET status=$4,last_error=$5,leased_until=NULL,
      sent_at=CASE WHEN $4='sent' THEN now() ELSE sent_at END,
      available_at=now()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(attempts,5)))::integer)
      WHERE notification_id=$1 AND subscription_id=$2 AND lease_id=$3`,
      [job.notification_id, job.subscription_id, job.lease_id, status, error],
    );
  }
}
