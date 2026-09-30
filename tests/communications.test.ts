import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Announcement,
  AnnouncementRepository,
} from '../src/announcements.js';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import {
  normalizedPollOptions,
  type Poll,
  type PollRepository,
  validatePollSelection,
} from '../src/polls.js';
import type { HouseholdRepository } from '../src/types.js';

const householdId = '00000000-0000-4000-8000-000000000001';
const recordId = '00000000-0000-4000-8000-000000000002';
const optionId = '00000000-0000-4000-8000-000000000003';
const memberId = '00000000-0000-4000-8000-000000000004';
const retryKey = '00000000-0000-4000-8000-000000000005';
const foreignId = '00000000-0000-4000-8000-000000000006';

test('communication routes authenticate, validate, and use the verified caller for responses', async () => {
  const calls: unknown[] = [];
  const access = (user: string, household: string) => {
    assert.equal(user, 'verified-user');
    if (household !== householdId)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
  };
  const announcement = { id: recordId, householdId } as Announcement;
  const poll = { id: recordId, householdId } as Poll;
  const announcements: AnnouncementRepository = {
    list: async (user, household, scope, limit, offset) => {
      access(user, household);
      calls.push(['announcements', scope, limit, offset]);
      return [announcement];
    },
    get: async (user, household, id) => {
      access(user, household);
      return id === recordId ? announcement : null;
    },
    create: async (user, household, draft) => {
      access(user, household);
      calls.push(['publish', draft.idempotencyKey]);
      return announcement;
    },
    acknowledge: async (user, household, id) => {
      access(user, household);
      calls.push(['ack', user, id]);
      return announcement;
    },
  };
  const polls: PollRepository = {
    list: async (user, household, scope, limit, offset) => {
      access(user, household);
      calls.push(['polls', scope, limit, offset]);
      return [poll];
    },
    get: async (user, household, id) => {
      access(user, household);
      return id === recordId ? poll : null;
    },
    create: async (user, household, draft) => {
      access(user, household);
      calls.push(['poll', draft.idempotencyKey]);
      return poll;
    },
    vote: async (user, household, id, optionIds) => {
      access(user, household);
      calls.push(['vote', user, id, optionIds]);
      return poll;
    },
  };
  const app = createApp({
    auth: async (token) =>
      token === 'valid'
        ? { id: 'verified-user', email: null, displayName: 'User' }
        : null,
    households: {} as HouseholdRepository,
    announcements,
    polls,
  });
  const headers = { authorization: 'Bearer valid' };
  const base = `/v1/households/${householdId}`;
  try {
    for (const section of ['announcements', 'polls']) {
      assert.equal((await app.inject(`${base}/${section}`)).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: `/v1/households/${foreignId}/${section}`,
            headers,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: `${base}/${section}/${foreignId}`, headers }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: `${base}/${section}?limit=51`, headers }))
          .statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `${base}/${section}?scope=invalid`, headers }))
          .statusCode,
        400,
      );
      const response = await app.inject({
        url: `${base}/${section}?limit=10&offset=20`,
        headers,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const announcementDraft = {
      title: 'Plumber',
      body: 'Tomorrow morning',
      priority: 'important',
      requiresAcknowledgement: true,
      recipientIds: [memberId],
      idempotencyKey: retryKey,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/announcements`,
          headers,
          payload: announcementDraft,
        })
      ).statusCode,
      201,
    );
    for (const invalid of [
      { priority: 'high' },
      { recipientIds: [memberId, memberId] },
      { expiresAtLocal: 'bad' },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/announcements`,
            headers,
            payload: { ...announcementDraft, ...invalid },
          })
        ).statusCode,
        400,
      );
    }
    const ackUrl = `${base}/announcements/${recordId}/acknowledgement`;
    assert.equal(
      (await app.inject({ method: 'PUT', url: ackUrl })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: ackUrl,
          headers,
          payload: { memberId: foreignId },
        })
      ).statusCode,
      200,
    );
    const pollDraft = {
      question: 'Which day?',
      options: ['Saturday', 'Sunday'],
      allowMultiple: false,
      deadlineLocal: '2030-10-01T12:00',
      voterIds: [memberId],
      idempotencyKey: retryKey,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/polls`,
          headers,
          payload: pollDraft,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/polls`,
          headers,
          payload: { ...pollDraft, options: ['One'] },
        })
      ).statusCode,
      400,
    );
    const voteUrl = `${base}/polls/${recordId}/vote`;
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: voteUrl,
          payload: { optionIds: [optionId] },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: voteUrl,
          headers,
          payload: { optionIds: [optionId, optionId] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: voteUrl,
          headers,
          payload: { optionIds: ['invalid'] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: voteUrl,
          headers,
          payload: { optionIds: [optionId], memberId: foreignId },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: voteUrl,
          headers,
          payload: { optionIds: [] },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(calls, [
      ['announcements', 'all', 10, 20],
      ['polls', 'open', 10, 20],
      ['publish', retryKey],
      ['ack', 'verified-user', recordId],
      ['poll', retryKey],
      ['vote', 'verified-user', recordId, [optionId]],
      ['vote', 'verified-user', recordId, []],
    ]);
  } finally {
    await app.close();
  }
});

test('poll validation rejects ambiguous choices and duplicate votes but allows withdrawal', () => {
  assert.deepEqual(normalizedPollOptions([' Saturday ', 'Sunday']), [
    'Saturday',
    'Sunday',
  ]);
  assert.throws(() => normalizedPollOptions(['Same', ' same ']), ApiError);
  assert.throws(() => normalizedPollOptions(['', 'Sunday']), ApiError);
  assert.throws(
    () => validatePollSelection([optionId, optionId], true),
    ApiError,
  );
  assert.throws(
    () => validatePollSelection([optionId, foreignId], false),
    ApiError,
  );
  assert.doesNotThrow(() => validatePollSelection([optionId, foreignId], true));
  assert.doesNotThrow(() => validatePollSelection([], false));
});
