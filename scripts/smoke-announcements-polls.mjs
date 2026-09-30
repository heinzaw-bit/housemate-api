import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgAnnouncementRepository } from '../dist/announcements.js';
import { PgPollRepository } from '../dist/polls.js';
import { PgHouseActionRepository } from '../dist/house-actions.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const connection = await pool.connect();
const code = (expected) => (error) => error.code === expected;
try {
  await connection.query('BEGIN');
  const users = (await connection.query('SELECT id, auth_user_id FROM housemate.users ORDER BY created_at LIMIT 2')).rows;
  assert.equal(users.length, 2, 'Two existing users are required for this rollback-only check.');
  const transactionPool = {
    connect: async () => ({
      query: (sql, params) => {
        if (sql.startsWith('BEGIN')) return connection.query('SAVEPOINT communication_smoke');
        if (sql === 'COMMIT') return connection.query('RELEASE SAVEPOINT communication_smoke');
        if (sql === 'ROLLBACK') return connection.query('ROLLBACK TO SAVEPOINT communication_smoke');
        return connection.query(sql, params);
      },
      release: () => {},
    }),
  };
  const announcements = new PgAnnouncementRepository(transactionPool);
  const polls = new PgPollRepository(transactionPool);
  const actions = new PgHouseActionRepository(transactionPool);
  const householdId = (await connection.query(
    `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
     VALUES ('Communication rollback test', 'THB', 'Asia/Bangkok', $1) RETURNING id`, [users[0].id],
  )).rows[0].id;
  const memberIds = [];
  for (const [index, user] of users.entries()) {
    memberIds.push((await connection.query(
      `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
       VALUES ($1,$2,$3,'active',now()) RETURNING id`, [householdId, user.id, index ? 'member' : 'owner'],
    )).rows[0].id);
  }
  const localTime = (await connection.query(
    `SELECT to_char((now() + interval '2 days') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI') AS value`,
  )).rows[0].value;
  const auth = users.map((user) => user.auth_user_id);
  const draft = { title: 'Water shutdown', body: 'Fill a bucket before noon.', priority: 'urgent', requiresAcknowledgement: true,
    recipientIds: memberIds, expiresAtLocal: localTime, idempotencyKey: randomUUID() };
  const announcement = await announcements.create(auth[0], householdId, draft);
  assert.equal(announcement.counts.awaiting, 2);
  assert.equal((await announcements.create(auth[0], householdId, draft)).id, announcement.id);
  await assert.rejects(announcements.create(auth[0], householdId, { ...draft, title: 'Different' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(announcements.create(auth[0], householdId, { ...draft, recipientIds: [randomUUID()], idempotencyKey: randomUUID() }), code('INVALID_RECIPIENTS'));
  await assert.rejects(announcements.create(auth[0], householdId, { ...draft, expiresAtLocal: '2026-02-30T12:00', idempotencyKey: randomUUID() }), code('INVALID_TIME'));
  assert.ok((await actions.get(auth[1], householdId)).announcements.some((record) => record.id === announcement.id));
  const acknowledged = await announcements.acknowledge(auth[1], householdId, announcement.id);
  const timestamp = acknowledged.recipients.find((person) => person.memberId === memberIds[1]).acknowledgedAt;
  assert.ok(timestamp);
  assert.equal(acknowledged.counts.awaiting, 1);
  assert.equal(acknowledged.canAcknowledge, false);
  assert.equal((await announcements.acknowledge(auth[1], householdId, announcement.id)).recipients.find((person) => person.memberId === memberIds[1]).acknowledgedAt, timestamp);
  assert.equal((await actions.get(auth[1], householdId)).announcements.length, 0);
  const privatePost = await announcements.create(auth[0], householdId, { ...draft, recipientIds: [memberIds[0]], idempotencyKey: randomUUID() });
  assert.equal(await announcements.get(auth[1], householdId, privatePost.id), null);
  assert.ok(!(await announcements.list(auth[1], householdId, 'all', 50, 0)).some((record) => record.id === privatePost.id));
  await assert.rejects(announcements.acknowledge(auth[1], householdId, privatePost.id), code('NOT_RECIPIENT'));
  const noAck = await announcements.create(auth[1], householdId, { ...draft, requiresAcknowledgement: false, recipientIds: [memberIds[1]], idempotencyKey: randomUUID() });
  assert.ok(await announcements.get(auth[0], householdId, noAck.id), 'Owner can read targeted posts.');
  await assert.rejects(announcements.acknowledge(auth[1], householdId, noAck.id), code('ACK_NOT_REQUIRED'));
  await connection.query('UPDATE housemate.announcements SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [announcement.id]);
  await assert.rejects(announcements.acknowledge(auth[0], householdId, announcement.id), code('ANNOUNCEMENT_EXPIRED'));
  assert.equal((await announcements.acknowledge(auth[1], householdId, announcement.id)).recipients.find((person) => person.memberId === memberIds[1]).acknowledgedAt, timestamp);
  assert.equal((await announcements.create(auth[0], householdId, draft)).id, announcement.id, 'Retry returns original after expiry.');
  assert.ok((await announcements.list(auth[0], householdId, 'expired', 50, 0)).some((record) => record.id === announcement.id));

  const pollDraft = { question: 'Which day?', options: [' Saturday ', 'Sunday'], allowMultiple: false, deadlineLocal: localTime, voterIds: memberIds, idempotencyKey: randomUUID() };
  const poll = await polls.create(auth[0], householdId, pollDraft);
  const [first, second] = poll.options.map((option) => option.id);
  assert.equal(poll.options[0].label, 'Saturday');
  assert.equal((await polls.create(auth[0], householdId, pollDraft)).id, poll.id);
  await assert.rejects(polls.create(auth[0], householdId, { ...pollDraft, question: 'Different' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(polls.create(auth[0], householdId, { ...pollDraft, options: ['Same', ' same '], idempotencyKey: randomUUID() }), code('INVALID_OPTIONS'));
  assert.ok((await actions.get(auth[1], householdId)).polls.some((record) => record.id === poll.id));
  let voted = await polls.vote(auth[1], householdId, poll.id, [first]);
  assert.equal(voted.responseCount, 1);
  assert.deepEqual(voted.myOptionIds, [first]);
  assert.equal((await polls.vote(auth[1], householdId, poll.id, [first])).options[0].voteCount, 1);
  assert.equal((await actions.get(auth[1], householdId)).polls.length, 0);
  voted = await polls.vote(auth[1], householdId, poll.id, [second]);
  assert.deepEqual(voted.options.map((option) => option.voteCount), [0, 1]);
  await assert.rejects(polls.vote(auth[1], householdId, poll.id, [first, first]), code('INVALID_VOTE'));
  await assert.rejects(polls.vote(auth[1], householdId, poll.id, [first, second]), code('INVALID_VOTE'));
  const privatePoll = await polls.create(auth[0], householdId, { ...pollDraft, voterIds: [memberIds[0]], idempotencyKey: randomUUID() });
  await assert.rejects(polls.vote(auth[1], householdId, poll.id, [privatePoll.options[0].id]), code('INVALID_VOTE'));
  assert.deepEqual((await polls.get(auth[1], householdId, poll.id)).myOptionIds, [second], 'Rejected update preserves previous vote.');
  assert.equal(await polls.get(auth[1], householdId, privatePoll.id), null);
  await assert.rejects(polls.vote(auth[1], householdId, privatePoll.id, []), code('NOT_ELIGIBLE'));
  const authored = await polls.create(auth[1], householdId, { ...pollDraft, voterIds: [memberIds[1]], idempotencyKey: randomUUID() });
  assert.equal((await polls.get(auth[0], householdId, authored.id)).canVote, false);
  await assert.rejects(polls.vote(auth[0], householdId, authored.id, [authored.options[0].id]), code('NOT_ELIGIBLE'));
  await connection.query('SAVEPOINT single_guard');
  await assert.rejects(connection.query(
    'INSERT INTO housemate.poll_votes (poll_id, member_id, option_id, allow_multiple) VALUES ($1,$2,$3,false)', [poll.id, memberIds[1], first],
  ), code('23505'));
  await connection.query('ROLLBACK TO SAVEPOINT single_guard');
  assert.equal((await polls.vote(auth[1], householdId, poll.id, [])).responseCount, 0);
  assert.ok((await actions.get(auth[1], householdId)).polls.some((record) => record.id === poll.id));
  const multi = await polls.create(auth[0], householdId, { ...pollDraft, allowMultiple: true, idempotencyKey: randomUUID() });
  const multiChoices = multi.options.map((option) => option.id);
  const multiVote = await polls.vote(auth[1], householdId, multi.id, multiChoices);
  assert.equal(multiVote.responseCount, 1);
  assert.deepEqual(multiVote.options.map((option) => option.voteCount), [1, 1]);
  assert.equal((await polls.vote(auth[1], householdId, multi.id, multiChoices)).responseCount, 1);
  await connection.query("UPDATE housemate.household_members SET status = 'removed' WHERE id = $1", [memberIds[1]]);
  const retained = await polls.get(auth[0], householdId, multi.id);
  assert.equal(retained.responseCount, 1);
  assert.equal(retained.activeVoterCount, 1);
  await assert.rejects(polls.vote(auth[1], householdId, multi.id, []), code('NOT_FOUND'));
  await assert.rejects(announcements.get(auth[1], householdId, announcement.id), code('NOT_FOUND'));
  await connection.query("UPDATE housemate.household_members SET status = 'active' WHERE id = $1", [memberIds[1]]);
  await connection.query('UPDATE housemate.polls SET deadline = now() - interval \'1 minute\' WHERE id = $1', [poll.id]);
  await assert.rejects(polls.vote(auth[1], householdId, poll.id, [first]), code('POLL_CLOSED'));
  assert.ok((await polls.list(auth[1], householdId, 'closed', 50, 0)).some((record) => record.id === poll.id));
  assert.ok(!(await actions.get(auth[1], householdId)).polls.some((record) => record.id === poll.id));
  assert.equal((await polls.create(auth[0], householdId, pollDraft)).id, poll.id);
  await assert.rejects(polls.get(auth[1], randomUUID(), poll.id), code('NOT_FOUND'));
  await assert.rejects(announcements.acknowledge(auth[1], randomUUID(), announcement.id), code('NOT_FOUND'));
  const rls = (await connection.query(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'housemate' AND c.relname = ANY($1::text[])`, [['announcements','announcement_recipients','polls','poll_options','poll_voters','poll_votes']])).rows;
  assert.equal(rls.length, 6);
  assert.ok(rls.every((row) => row.relrowsecurity));
  console.log('Publication retries, recipient privacy, acknowledgement timestamps, vote replacement/withdrawal, single/multiple choices, database constraints, membership removal, deadlines, House actions, and RLS passed; fixture rolled back.');
} finally {
  await connection.query('ROLLBACK');
  connection.release();
  await pool.end();
}
