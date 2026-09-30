import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AnnouncementDraft,
  AnnouncementRepository,
  AnnouncementScope,
} from './announcements.js';
import { ApiError } from './errors.js';
import type { PollDraft, PollRepository, PollScope } from './polls.js';
import type { AuthenticatedUser } from './types.js';

const householdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const memberIds = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  items: { type: 'string', format: 'uuid' },
} as const;
const localTime = {
  type: 'string',
  pattern: '^[1-9]\\d{3}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
} as const;
function itemParams(name: string) {
  return {
    type: 'object',
    required: ['id', name],
    properties: {
      id: { type: 'string', format: 'uuid' },
      [name]: { type: 'string', format: 'uuid' },
    },
  };
}
function pageQuery(scopes: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: { type: 'string', enum: scopes },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  };
}

export function registerCommunicationRoutes(
  app: FastifyInstance,
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>,
  announcements?: AnnouncementRepository,
  polls?: PollRepository,
) {
  if (announcements) {
    app.get<{
      Params: { id: string };
      Querystring: {
        scope?: AnnouncementScope;
        limit?: number;
        offset?: number;
      };
    }>(
      '/v1/households/:id/announcements',
      {
        schema: {
          params: householdParams,
          querystring: pageQuery(['all', 'needs_ack', 'expired']),
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply.header('Cache-Control', 'no-store').send({
          announcements: await announcements.list(
            user.id,
            request.params.id,
            request.query.scope ?? 'all',
            request.query.limit ?? 20,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; announcementId: string } }>(
      '/v1/households/:id/announcements/:announcementId',
      { schema: { params: itemParams('announcementId') } },
      async (request, reply) => {
        const user = await authenticate(request);
        const record = await announcements.get(
          user.id,
          request.params.id,
          request.params.announcementId,
        );
        if (!record)
          throw new ApiError(404, 'NOT_FOUND', 'Announcement not found.');
        return reply.header('Cache-Control', 'no-store').send(record);
      },
    );
    app.post<{ Params: { id: string }; Body: AnnouncementDraft }>(
      '/v1/households/:id/announcements',
      {
        schema: {
          params: householdParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'title',
              'body',
              'priority',
              'requiresAcknowledgement',
              'recipientIds',
              'idempotencyKey',
            ],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 160 },
              body: { type: 'string', minLength: 1, maxLength: 4000 },
              priority: {
                type: 'string',
                enum: ['normal', 'important', 'urgent'],
              },
              requiresAcknowledgement: { type: 'boolean' },
              recipientIds: memberIds,
              expiresAtLocal: { anyOf: [localTime, { type: 'null' }] },
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await announcements.create(
              user.id,
              request.params.id,
              request.body,
            ),
          );
      },
    );
    app.put<{ Params: { id: string; announcementId: string } }>(
      '/v1/households/:id/announcements/:announcementId/acknowledgement',
      { schema: { params: itemParams('announcementId') } },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await announcements.acknowledge(
              user.id,
              request.params.id,
              request.params.announcementId,
            ),
          );
      },
    );
  }
  if (polls) {
    app.get<{
      Params: { id: string };
      Querystring: { scope?: PollScope; limit?: number; offset?: number };
    }>(
      '/v1/households/:id/polls',
      {
        schema: {
          params: householdParams,
          querystring: pageQuery(['open', 'needs_vote', 'closed']),
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply.header('Cache-Control', 'no-store').send({
          polls: await polls.list(
            user.id,
            request.params.id,
            request.query.scope ?? 'open',
            request.query.limit ?? 20,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; pollId: string } }>(
      '/v1/households/:id/polls/:pollId',
      { schema: { params: itemParams('pollId') } },
      async (request, reply) => {
        const user = await authenticate(request);
        const record = await polls.get(
          user.id,
          request.params.id,
          request.params.pollId,
        );
        if (!record) throw new ApiError(404, 'NOT_FOUND', 'Poll not found.');
        return reply.header('Cache-Control', 'no-store').send(record);
      },
    );
    app.post<{ Params: { id: string }; Body: PollDraft }>(
      '/v1/households/:id/polls',
      {
        schema: {
          params: householdParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'question',
              'options',
              'allowMultiple',
              'deadlineLocal',
              'voterIds',
              'idempotencyKey',
            ],
            properties: {
              question: { type: 'string', minLength: 1, maxLength: 240 },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 10,
                items: { type: 'string', minLength: 1, maxLength: 100 },
              },
              allowMultiple: { type: 'boolean' },
              deadlineLocal: localTime,
              voterIds: memberIds,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(await polls.create(user.id, request.params.id, request.body));
      },
    );
    app.put<{
      Params: { id: string; pollId: string };
      Body: { optionIds: string[] };
    }>(
      '/v1/households/:id/polls/:pollId/vote',
      {
        schema: {
          params: itemParams('pollId'),
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['optionIds'],
            properties: {
              optionIds: {
                type: 'array',
                maxItems: 10,
                uniqueItems: true,
                items: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await polls.vote(
              user.id,
              request.params.id,
              request.params.pollId,
              request.body.optionIds,
            ),
          );
      },
    );
  }
}
