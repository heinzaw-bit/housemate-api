import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { UUID_PATTERN } from './auth.js';
import { ApiError } from './errors.js';

// Called after membership authorization, inside the same transaction as creation.
// The immutable key/hash plus the existing creator/time/record ID trace execution.
export async function priorCreate(
  client: PoolClient,
  table: 'shopping_items' | 'chores',
  household: string,
  user: string,
  key: string | undefined,
  payload: unknown,
) {
  if (key === undefined) return { id: null, hash: null };
  if (!UUID_PATTERN.test(key))
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Enter a valid confirmation key.',
    );
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${table}:${household}:${user}:${key}`,
  ]);
  const prior = await client.query<{ id: string; request_hash: string }>(
    `SELECT id, request_hash FROM housemate.${table} WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3`,
    [household, user, key],
  );
  const row = prior.rows[0];
  if (row && row.request_hash !== hash)
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This confirmation key was already used for different details.',
    );
  return { id: row?.id ?? null, hash };
}
