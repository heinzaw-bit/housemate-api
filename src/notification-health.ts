import type { Pool } from 'pg';
export interface DeliveryHealth {
  pending: number;
  oldestDueSeconds: number;
  recentFailures: number;
  acceptedLast15Minutes: number;
  maxCreationToAcceptanceSeconds: number;
  maxQueueToAcceptanceSeconds: number;
  healthy: boolean;
}
export async function notificationHealth(pool: Pool): Promise<DeliveryHealth> {
  const result = await pool.query(`SELECT
    count(*) FILTER (WHERE s.enabled AND n.read_at IS NULL AND n.expires_at>now() AND d.status IN ('pending','processing') AND d.available_at <= now() AND (d.status='pending' OR d.leased_until<now()))::int AS pending,
    COALESCE(max(EXTRACT(epoch FROM now()-d.available_at)) FILTER (WHERE s.enabled AND n.read_at IS NULL AND n.expires_at>now() AND d.status IN ('pending','processing') AND d.available_at<=now() AND (d.status='pending' OR d.leased_until<now())),0)::int AS oldest,
    count(*) FILTER (WHERE (d.status IN ('failed','invalid') OR (d.status='pending' AND d.attempts>=3 AND d.last_error IS NOT NULL)) AND d.last_attempt_at>now()-interval '15 minutes')::int AS failures,
    count(*) FILTER (WHERE d.status='sent' AND d.sent_at>now()-interval '15 minutes')::int AS accepted,
    COALESCE(max(EXTRACT(epoch FROM d.sent_at-n.created_at)) FILTER (WHERE d.status='sent' AND d.sent_at>now()-interval '15 minutes'),0)::int AS creation_delay,
    COALESCE(max(EXTRACT(epoch FROM d.sent_at-d.queued_at)) FILTER (WHERE d.status='sent' AND d.sent_at>now()-interval '15 minutes'),0)::int AS queue_delay
    FROM housemate.push_deliveries d JOIN housemate.notifications n ON n.id=d.notification_id
    JOIN housemate.push_subscriptions s ON s.id=d.subscription_id
    WHERE d.status IN ('pending','processing') OR d.sent_at>now()-interval '15 minutes' OR d.last_attempt_at>now()-interval '15 minutes'`);
  const row = result.rows[0];
  return {
    pending: row.pending,
    oldestDueSeconds: row.oldest,
    recentFailures: row.failures,
    acceptedLast15Minutes: row.accepted,
    maxCreationToAcceptanceSeconds: row.creation_delay,
    maxQueueToAcceptanceSeconds: row.queue_delay,
    healthy: row.oldest < 180 && row.failures === 0,
  };
}
