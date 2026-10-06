import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withCommunicationAccess } from './communication-access.js';
import { ApiError } from './errors.js';
import { type PushSender, pushErrorOutcome } from './notification-worker.js';
import { validatePushRegistration } from './notifications.js';
export type PushTestResult = { status: 'accepted'; acceptedAt: string };
export class PushTestService {
  constructor(
    private pool: Pool,
    private sender: PushSender | null,
    private publicKey: string | null,
  ) {}
  async send(
    user: string,
    household: string,
    subscriptionId: string,
  ): Promise<PushTestResult> {
    // Reserve the cooldown transactionally before touching a provider. A failed attempt
    // cannot roll back the reservation or be replayed by a retried HTTP request.
    const subscription = await withCommunicationAccess(
      this.pool,
      user,
      household,
      true,
      async (client, access) => {
        const found = await client.query(
          `SELECT endpoint,p256dh,auth,enabled,vapid_public_key,last_test_at,
        last_test_at > now()-interval '1 minute' AS cooling FROM housemate.push_subscriptions
        WHERE id=$1 AND user_id=$2 FOR UPDATE`,
          [subscriptionId, access.userId],
        );
        const row = found.rows[0];
        if (!row)
          throw new ApiError(404, 'NOT_FOUND', 'Push device not found.');
        if (!this.sender || !this.publicKey)
          throw new ApiError(
            503,
            'PUSH_NOT_CONFIGURED',
            'Device notifications are unavailable.',
          );
        if (!row.enabled || row.vapid_public_key !== this.publicKey)
          throw new ApiError(
            409,
            'DEVICE_DISABLED',
            'Enable this device before testing.',
          );
        if (row.cooling)
          throw new ApiError(
            429,
            'TEST_COOLDOWN',
            'Wait one minute before testing this device again.',
          );
        const value = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        validatePushRegistration(value);
        await client.query(
          "UPDATE housemate.push_subscriptions SET last_test_at=now(),last_test_status='sending',last_test_accepted_at=NULL WHERE id=$1",
          [subscriptionId],
        );
        return value;
      },
    );
    try {
      // Revalidate membership/device after the reservation, before sending.
      await withCommunicationAccess(
        this.pool,
        user,
        household,
        false,
        async (client, access) => {
          const current = await client.query(
            'SELECT id FROM housemate.push_subscriptions WHERE id=$1 AND user_id=$2 AND enabled AND vapid_public_key=$3',
            [subscriptionId, access.userId, this.publicKey],
          );
          if (!current.rowCount)
            throw new ApiError(
              409,
              'DEVICE_DISABLED',
              'Enable this device before testing.',
            );
        },
      );
      if (!this.sender) throw new Error('Push unavailable');
      await this.sender(
        subscription,
        JSON.stringify({
          id: randomUUID(),
          test: true,
          href: `/notifications?household=${encodeURIComponent(household)}&view=settings`,
        }),
        60,
        'normal',
      );
      const accepted = await this.pool.query(
        "UPDATE housemate.push_subscriptions SET last_test_status='accepted',last_test_accepted_at=now(),last_sent_at=now(),last_error=NULL WHERE id=$1 RETURNING last_test_accepted_at",
        [subscriptionId],
      );
      return {
        status: 'accepted',
        acceptedAt: accepted.rows[0].last_test_accepted_at.toISOString(),
      };
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode)
          : undefined;
      const invalid = pushErrorOutcome(status, 1) === 'invalid';
      await this.pool.query(
        'UPDATE housemate.push_subscriptions SET last_test_status=$2,last_error=$3,enabled=CASE WHEN $4 THEN false ELSE enabled END WHERE id=$1',
        [
          subscriptionId,
          invalid ? 'invalid' : 'failed',
          Number.isFinite(status) ? `HTTP_${status}` : 'TEST_FAILED',
          invalid,
        ],
      );
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'PUSH_TEST_FAILED',
        'The test was not confirmed by the push service. Check this device and try again in a minute.',
      );
    }
  }
}
