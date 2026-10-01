import type { Pool } from 'pg';
import { ApiError } from './errors.js';

export interface AssistantBudget {
  consume(authUserId: string): Promise<void>;
}

// One shared UTC-day lock makes both counters atomic across serverless instances.
// Failed provider attempts consume a slot: there are no hidden retries.
export class PgAssistantBudget implements AssistantBudget {
  constructor(private readonly pool: Pool) {}
  async consume(authUserId: string): Promise<void> {
    const client = await this.pool.connect().catch(() => {
      throw new ApiError(
        503,
        'ASSISTANT_UNAVAILABLE',
        'AI questions are temporarily unavailable. Use a quick question instead.',
      );
    });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('housemate.assistant.budget', 0))",
      );
      // Delete only expired counters; no messages or household content are stored.
      await client.query(
        'DELETE FROM housemate.assistant_usage WHERE expires_at <= now()',
      );
      const clock = await client.query<{ day: string; hour: string }>(
        "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD-HH24') AS hour",
      );
      const time = clock.rows[0];
      if (!time) throw new Error('Missing assistant clock');
      const keys = [`day:${time.day}`, `user:${authUserId}:${time.hour}`];
      const usage = await client.query<{ bucket: string; requests: number }>(
        'SELECT bucket, requests FROM housemate.assistant_usage WHERE bucket = ANY($1::text[])',
        [keys],
      );
      if (
        usage.rows.some(
          (row) => row.requests >= (row.bucket.startsWith('day:') ? 200 : 20),
        )
      ) {
        throw new ApiError(
          429,
          'AI_LIMIT_REACHED',
          'The AI question limit has been reached. Use a quick question or try again after the next hourly or daily UTC reset.',
        );
      }
      await client.query(
        `INSERT INTO housemate.assistant_usage (bucket, requests, expires_at)
        VALUES ($1, 1, date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day'),
               ($2, 1, date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 hour')
        ON CONFLICT (bucket) DO UPDATE SET requests = assistant_usage.requests + 1`,
        keys,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'ASSISTANT_UNAVAILABLE',
        'AI questions are temporarily unavailable. Use a quick question instead.',
      );
    } finally {
      client.release();
    }
  }
}
