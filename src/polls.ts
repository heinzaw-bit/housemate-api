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

export type PollScope = 'open' | 'needs_vote' | 'closed';
export interface PollDraft {
  question: string;
  options: string[];
  allowMultiple: boolean;
  deadlineLocal: string;
  voterIds: string[];
  idempotencyKey: string;
}
export interface Poll {
  id: string;
  householdId: string;
  question: string;
  allowMultiple: boolean;
  deadline: string;
  timezone: string;
  createdAt: string;
  authorDisplayName: string;
  viewerMemberId: string;
  options: { id: string; label: string; position: number; voteCount: number }[];
  voterCount: number;
  activeVoterCount: number;
  responseCount: number;
  myOptionIds: string[];
  canVote: boolean;
  closed: boolean;
}
export interface PollRepository {
  list(
    authUserId: string,
    householdId: string,
    scope: PollScope,
    limit: number,
    offset: number,
  ): Promise<Poll[]>;
  get(
    authUserId: string,
    householdId: string,
    pollId: string,
  ): Promise<Poll | null>;
  create(
    authUserId: string,
    householdId: string,
    draft: PollDraft,
  ): Promise<Poll>;
  vote(
    authUserId: string,
    householdId: string,
    pollId: string,
    optionIds: string[],
  ): Promise<Poll>;
}
interface PollRow {
  id: string;
  household_id: string;
  question: string;
  allow_multiple: boolean;
  deadline: Date;
  timezone: string;
  created_at: Date;
  author_display_name: string;
  voter_count: number;
  active_voter_count: number;
  response_count: number;
  eligible: boolean;
  closed: boolean;
}
const visibility = `(p.created_by_user_id = $2 OR $4::boolean OR EXISTS (
  SELECT 1 FROM housemate.poll_voters pv WHERE pv.poll_id = p.id AND pv.member_id = $3))`;

export function normalizedPollOptions(options: string[]): string[] {
  const labels = options.map((label) => label.trim());
  if (
    labels.length < 2 ||
    labels.length > 10 ||
    labels.some((label) => !label || label.length > 100) ||
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  )
    throw new ApiError(
      400,
      'INVALID_OPTIONS',
      'Enter 2–10 different choices, each up to 100 characters.',
    );
  return labels;
}

export function validatePollSelection(
  optionIds: string[],
  allowMultiple: boolean,
): void {
  if (optionIds.length > 10 || new Set(optionIds).size !== optionIds.length)
    throw new ApiError(
      400,
      'INVALID_VOTE',
      'Choose each poll option at most once.',
    );
  if (!allowMultiple && optionIds.length > 1)
    throw new ApiError(
      400,
      'INVALID_VOTE',
      'This poll allows only one choice.',
    );
}

export class PgPollRepository implements PollRepository {
  constructor(private readonly pool: Pool) {}

  private async readMany(
    client: PoolClient,
    householdId: string,
    access: CommunicationAccess,
    ids: string[],
  ): Promise<Poll[]> {
    if (!ids.length) return [];
    const records = await client.query<PollRow>(
      `SELECT p.*, u.display_name AS author_display_name, p.deadline <= clock_timestamp() AS closed,
         (SELECT COUNT(*)::integer FROM housemate.poll_voters pv WHERE pv.poll_id = p.id) AS voter_count,
         (SELECT COUNT(*)::integer FROM housemate.poll_voters pv JOIN housemate.household_members m ON m.id = pv.member_id
           WHERE pv.poll_id = p.id AND m.status = 'active') AS active_voter_count,
         (SELECT COUNT(DISTINCT v.member_id)::integer FROM housemate.poll_votes v WHERE v.poll_id = p.id) AS response_count,
         EXISTS (SELECT 1 FROM housemate.poll_voters pv WHERE pv.poll_id = p.id AND pv.member_id = $3) AS eligible
       FROM housemate.polls p JOIN housemate.users u ON u.id = p.created_by_user_id
       WHERE p.household_id = $1 AND ${visibility} AND p.id = ANY($5::uuid[])`,
      [householdId, access.userId, access.memberId, access.moderator, ids],
    );
    const options = await client.query<{
      id: string;
      poll_id: string;
      label: string;
      position: number;
      vote_count: number;
      mine: boolean;
    }>(
      `SELECT po.id, po.poll_id, po.label, po.position, COUNT(v.member_id)::integer AS vote_count,
         COALESCE(bool_or(v.member_id = $2), false) AS mine
       FROM housemate.poll_options po
       LEFT JOIN housemate.poll_votes v ON v.poll_id = po.poll_id AND v.option_id = po.id
       WHERE po.poll_id = ANY($1::uuid[])
       GROUP BY po.id ORDER BY po.position, po.id`,
      [records.rows.map((record) => record.id), access.memberId],
    );
    const mapped = new Map(
      records.rows.map((row) => {
        const choices = options.rows.filter(
          (option) => option.poll_id === row.id,
        );
        return [
          row.id,
          {
            id: row.id,
            householdId: row.household_id,
            question: row.question,
            allowMultiple: row.allow_multiple,
            deadline: row.deadline.toISOString(),
            timezone: row.timezone,
            createdAt: row.created_at.toISOString(),
            authorDisplayName: row.author_display_name,
            viewerMemberId: access.memberId,
            options: choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              position: choice.position,
              voteCount: choice.vote_count,
            })),
            voterCount: row.voter_count,
            activeVoterCount: row.active_voter_count,
            responseCount: row.response_count,
            myOptionIds: choices
              .filter((choice) => choice.mine)
              .map((choice) => choice.id),
            canVote: row.eligible && !row.closed,
            closed: row.closed,
          } satisfies Poll,
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
    scope: PollScope = 'open',
    limit = 50,
    offset = 0,
  ) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      false,
      async (client, access) => {
        const clause =
          scope === 'closed'
            ? 'AND p.deadline <= now()'
            : `AND p.deadline > now() ${
                scope === 'needs_vote'
                  ? `
        AND EXISTS (SELECT 1 FROM housemate.poll_voters pv WHERE pv.poll_id = p.id AND pv.member_id = $3)
        AND NOT EXISTS (SELECT 1 FROM housemate.poll_votes v WHERE v.poll_id = p.id AND v.member_id = $3)`
                  : ''
              }`;
        const result = await client.query<{ id: string }>(
          `SELECT p.id FROM housemate.polls p WHERE p.household_id = $1 AND ${visibility} ${clause}
         ORDER BY p.deadline ${scope === 'closed' ? 'DESC' : 'ASC'}, p.id ASC LIMIT $5 OFFSET $6`,
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

  async get(authUserId: string, householdId: string, pollId: string) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      false,
      async (client, access) =>
        (await this.readMany(client, householdId, access, [pollId]))[0] ?? null,
    );
  }

  async create(authUserId: string, householdId: string, draft: PollDraft) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      true,
      async (client, access) => {
        const question = draft.question.trim();
        const options = normalizedPollOptions(draft.options);
        const voterIds = normalizedMemberIds(draft.voterIds);
        if (!question || question.length > 240)
          throw new ApiError(
            400,
            'INVALID_POLL',
            'Enter a question up to 240 characters.',
          );
        const hash = createHash('sha256')
          .update(
            JSON.stringify({
              question,
              options,
              allowMultiple: draft.allowMultiple,
              deadlineLocal: draft.deadlineLocal,
              voterIds,
            }),
          )
          .digest('hex');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`poll:${householdId}:${access.userId}:${draft.idempotencyKey}`],
        );
        const prior = await client.query<{ id: string; request_hash: string }>(
          'SELECT id, request_hash FROM housemate.polls WHERE household_id = $1 AND created_by_user_id = $2 AND idempotency_key = $3',
          [householdId, access.userId, draft.idempotencyKey],
        );
        let id = prior.rows[0]?.id;
        if (id && prior.rows[0]?.request_hash !== hash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This poll publication key was already used for different details.',
          );
        if (!id) {
          await checkActiveRecipients(client, householdId, voterIds);
          const deadline = await futureLocalTime(
            client,
            draft.deadlineLocal,
            access.timezone,
          );
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO housemate.polls (household_id, question, allow_multiple, deadline, timezone, created_by_user_id, idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              householdId,
              question,
              draft.allowMultiple,
              deadline,
              access.timezone,
              access.userId,
              draft.idempotencyKey,
              hash,
            ],
          );
          id = inserted.rows[0]?.id;
          if (!id) throw new Error('Could not publish poll');
          await client.query(
            `INSERT INTO housemate.poll_options (poll_id, label, position)
           SELECT $1::uuid, label, (position - 1)::integer FROM unnest($2::text[]) WITH ORDINALITY AS choices(label, position)`,
            [id, options],
          );
          await client.query(
            `INSERT INTO housemate.poll_voters (poll_id, member_id)
           SELECT $1::uuid, member_id FROM unnest($2::uuid[]) AS member_id`,
            [id, voterIds],
          );
        }
        const record = (
          await this.readMany(client, householdId, access, [id])
        )[0];
        if (!record) throw new Error('Could not read poll');
        return record;
      },
    );
  }

  async vote(
    authUserId: string,
    householdId: string,
    pollId: string,
    optionIds: string[],
  ) {
    return withCommunicationAccess(
      this.pool,
      authUserId,
      householdId,
      true,
      async (client, access) => {
        const result = await client.query<{
          allow_multiple: boolean;
          deadline: Date;
        }>(
          'SELECT allow_multiple, deadline FROM housemate.polls WHERE household_id = $1 AND id = $2 FOR UPDATE',
          [householdId, pollId],
        );
        const poll = result.rows[0];
        if (!poll) throw new ApiError(404, 'NOT_FOUND', 'Poll not found.');
        const voter = await client.query(
          'SELECT 1 FROM housemate.poll_voters WHERE poll_id = $1 AND member_id = $2',
          [pollId, access.memberId],
        );
        if (!voter.rowCount)
          throw new ApiError(
            403,
            'NOT_ELIGIBLE',
            'You are not selected to vote in this poll.',
          );
        const expiry = await client.query<{ closed: boolean }>(
          'SELECT $1::timestamptz <= clock_timestamp() AS closed',
          [poll.deadline],
        );
        if (expiry.rows[0]?.closed)
          throw new ApiError(
            409,
            'POLL_CLOSED',
            'The poll deadline has passed. Votes are now closed.',
          );
        validatePollSelection(optionIds, poll.allow_multiple);
        const choices = await client.query(
          'SELECT id FROM housemate.poll_options WHERE poll_id = $1 AND id = ANY($2::uuid[])',
          [pollId, optionIds],
        );
        if (choices.rows.length !== optionIds.length)
          throw new ApiError(
            400,
            'INVALID_VOTE',
            'Choose options that belong to this poll.',
          );
        await client.query(
          'DELETE FROM housemate.poll_votes WHERE poll_id = $1 AND member_id = $2',
          [pollId, access.memberId],
        );
        await client.query(
          `INSERT INTO housemate.poll_votes (poll_id, member_id, option_id, allow_multiple)
         SELECT $1::uuid, $2::uuid, option_id, $4::boolean FROM unnest($3::uuid[]) AS option_id`,
          [pollId, access.memberId, optionIds, poll.allow_multiple],
        );
        const record = (
          await this.readMany(client, householdId, access, [pollId])
        )[0];
        if (!record) throw new Error('Could not read poll');
        return record;
      },
    );
  }
}
