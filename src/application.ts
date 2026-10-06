import { createHash, randomBytes } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyRequest, LogController } from 'fastify';
import type { AnnouncementRepository } from './announcements.js';
import {
  type HouseholdAssistant,
  registerAssistantRoutes,
} from './assistant.js';
import { UUID_PATTERN } from './auth.js';
import type {
  BillDraft,
  BillPaymentStatus,
  BillRepository,
} from './bill-types.js';
import type { ChoreDraft, ChoreRepository } from './chores.js';
import { registerCommunicationRoutes } from './communication-routes.js';
import type { DashboardRepository } from './dashboard.js';
import { ApiError } from './errors.js';
import type {
  EventDraft,
  EventRepository,
  EventResponse,
  EventScope,
} from './events.js';
import type { ExpenseDraft, ExpenseRepository } from './expense-types.js';
import type { HouseActionRepository } from './house-actions.js';
import type {
  MealDraft,
  MealListScope,
  MealRepository,
  MealResponse,
  MealRole,
} from './meals.js';
import type { MoneyRepository, SettlementDraft } from './money-types.js';
import { registerNotificationRoutes } from './notification-routes.js';
import type { NotificationRepository, PushConfig } from './notifications.js';
import type { PollRepository } from './polls.js';
import type { PushTestService } from './push-test.js';
import type { SearchRepository } from './search.js';
import { registerSearchRoutes } from './search-routes.js';
import type { ShoppingDraft, ShoppingRepository } from './shopping.js';
import type {
  AuthenticatedUser,
  AuthVerifier,
  CreateHouseholdInput,
  HouseholdRepository,
  UpdateHouseholdInput,
} from './types.js';

interface AppDependencies {
  fastifyFactory?: typeof Fastify;
  auth: AuthVerifier;
  assistant?: HouseholdAssistant;
  households: HouseholdRepository;
  expenses?: ExpenseRepository;
  bills?: BillRepository;
  money?: MoneyRepository;
  dashboard?: DashboardRepository;
  houseActions?: HouseActionRepository;
  search?: SearchRepository;
  meals?: MealRepository;
  shopping?: ShoppingRepository;
  chores?: ChoreRepository;
  events?: EventRepository;
  announcements?: AnnouncementRepository;
  polls?: PollRepository;
  notifications?: NotificationRepository;
  pushConfig?: PushConfig;
  pushTests?: PushTestService;
  webOrigins?: string[];
  readiness?: () => Promise<void>;
  reportError?: (error: unknown, operation: string) => Promise<void>;
}

const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const;

const householdResponse = {
  type: 'object',
  required: [
    'id',
    'name',
    'defaultCurrency',
    'timezone',
    'role',
    'currencyEditable',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    defaultCurrency: { type: 'string', enum: ['USD', 'THB'] },
    timezone: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'admin', 'member'] },
    currencyEditable: { type: 'boolean' },
    createdAt: { type: 'string' },
  },
} as const;

const memberResponse = {
  type: 'object',
  required: ['id', 'displayName', 'email', 'role', 'joinedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { type: 'string' },
    email: { type: ['string', 'null'] },
    role: { type: 'string', enum: ['owner', 'admin', 'member'] },
    joinedAt: { type: 'string' },
  },
} as const;

const inviteResponse = {
  type: 'object',
  required: ['id', 'createdAt', 'expiresAt', 'redeemedAt', 'revokedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    redeemedAt: { type: ['string', 'null'] },
    revokedAt: { type: ['string', 'null'] },
  },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const historyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

const inviteTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function hashInviteToken(token: string): string {
  if (!inviteTokenPattern.test(token))
    throw new ApiError(
      404,
      'INVALID_INVITE',
      'This invitation link is invalid.',
    );
  return createHash('sha256').update(token).digest('hex');
}

async function requireUser(
  request: FastifyRequest,
  auth: AuthVerifier,
): Promise<AuthenticatedUser> {
  const header = request.headers.authorization;
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  if (!match?.[1])
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'A valid bearer token is required.',
    );
  try {
    const user = await auth(match[1]);
    if (!user)
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'A valid bearer token is required.',
      );
    return user;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      'AUTH_UNAVAILABLE',
      'Authentication is temporarily unavailable.',
    );
  }
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function createApp({
  fastifyFactory = Fastify,
  auth,
  assistant,
  households,
  expenses,
  bills,
  money,
  dashboard,
  houseActions,
  search,
  meals,
  shopping,
  chores,
  events,
  announcements,
  polls,
  notifications,
  pushTests,
  pushConfig = { enabled: false, publicKey: null, reason: 'server_setup' },
  webOrigins = ['http://localhost:3000'],
  readiness,
  reportError = async () => {},
}: AppDependencies) {
  // Invite tokens travel in route paths. Do not write request URLs to logs.
  const app = fastifyFactory({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.register(cors, {
    origin: webOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  registerSearchRoutes(app, (request) => requireUser(request, auth), search);
  registerNotificationRoutes(
    app,
    (request) => requireUser(request, auth),
    notifications,
    pushConfig,
    pushTests,
  );
  registerAssistantRoutes(
    app,
    (request) => requireUser(request, auth),
    assistant,
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500)
        await reportError(error, 'api.request').catch(() => {});
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (
      error &&
      typeof error === 'object' &&
      'validation' in error &&
      error.validation
    ) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
      });
    }
    request.log.error('Unexpected API request failure.');
    await reportError(error, 'api.request').catch(() => {});
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (!readiness) throw new Error('Readiness is not configured');
      await readiness();
      return { status: 'ok' };
    } catch (error) {
      await reportError(error, 'api.readiness').catch(() => {});
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get('/v1/me', async (request) => {
    const user = await requireUser(request, auth);
    return households.getProfile(user);
  });

  app.patch<{ Body: { displayName: string } }>(
    '/v1/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName'],
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      const displayName = request.body.displayName.trim();
      if (!displayName)
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Display name is required.',
        );
      return households.updateProfile(user, displayName);
    },
  );

  app.get('/v1/households', async (request) => {
    const user = await requireUser(request, auth);
    return { households: await households.list(user.id) };
  });

  app.post<{ Body: CreateHouseholdInput }>(
    '/v1/households',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'currency', 'timezone'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            currency: { type: 'string', enum: ['USD', 'THB'] },
            timezone: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        response: {
          201: householdResponse,
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(request, auth);
      const name = request.body.name.trim();
      if (!name)
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Household name is required.',
        );
      if (!validTimeZone(request.body.timezone)) {
        throw new ApiError(
          400,
          'INVALID_TIMEZONE',
          'Use a valid IANA timezone.',
        );
      }
      const household = await households.create(user, {
        ...request.body,
        name,
      });
      return reply.status(201).send(household);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/households/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: householdResponse, 404: errorResponse },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      if (!UUID_PATTERN.test(request.params.id)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid household ID.');
      }
      const household = await households.get(user.id, request.params.id);
      if (!household)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      return household;
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateHouseholdInput }>(
    '/v1/households/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            timezone: { type: 'string', minLength: 1, maxLength: 100 },
            currency: { type: 'string', enum: ['USD', 'THB'] },
          },
        },
        response: { 200: householdResponse },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      const input = { ...request.body };
      if (input.name !== undefined) {
        input.name = input.name.trim();
        if (!input.name)
          throw new ApiError(
            400,
            'VALIDATION_ERROR',
            'Household name is required.',
          );
      }
      if (input.timezone !== undefined) {
        input.timezone = input.timezone.trim();
        if (!validTimeZone(input.timezone))
          throw new ApiError(
            400,
            'INVALID_TIMEZONE',
            'Use a valid IANA timezone.',
          );
      }
      return households.update(user.id, request.params.id, input);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/households/:id/members',
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: 'object',
            required: ['members'],
            properties: { members: { type: 'array', items: memberResponse } },
          },
        },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      const household = await households.get(user.id, request.params.id);
      if (!household)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      return {
        members: await households.listMembers(user.id, request.params.id),
      };
    },
  );

  app.patch<{
    Params: { id: string; memberId: string };
    Body: { role: 'admin' | 'member' };
  }>(
    '/v1/households/:id/members/:memberId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'memberId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            memberId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: { role: { type: 'string', enum: ['admin', 'member'] } },
        },
        response: { 200: memberResponse },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      return households.updateMemberRole(
        user.id,
        request.params.id,
        request.params.memberId,
        request.body.role,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/households/:id/invites',
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: 'object',
            required: ['invites'],
            properties: { invites: { type: 'array', items: inviteResponse } },
          },
        },
      },
    },
    async (request) => {
      const user = await requireUser(request, auth);
      return {
        invites: await households.listInvites(user.id, request.params.id),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/households/:id/invites',
    {
      schema: {
        params: idParams,
        response: {
          201: {
            ...inviteResponse,
            required: [...inviteResponse.required, 'token'],
            properties: {
              ...inviteResponse.properties,
              token: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(request, auth);
      const token = randomBytes(32).toString('base64url');
      const invite = await households.createInvite(
        user.id,
        request.params.id,
        hashInviteToken(token),
      );
      return reply
        .header('Cache-Control', 'no-store')
        .status(201)
        .send({ ...invite, token });
    },
  );

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/v1/households/:id/invites/:inviteId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'inviteId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            inviteId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(request, auth);
      await households.revokeInvite(
        user.id,
        request.params.id,
        request.params.inviteId,
      );
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/invites/:token',
    async (request, reply) => {
      const user = await requireUser(request, auth);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await households.previewInvite(
            user.id,
            hashInviteToken(request.params.token),
          ),
        );
    },
  );

  app.post<{ Params: { token: string } }>(
    '/v1/invites/:token/accept',
    { schema: { response: { 200: householdResponse } } },
    async (request, reply) => {
      const user = await requireUser(request, auth);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await households.acceptInvite(
            user,
            hashInviteToken(request.params.token),
          ),
        );
    },
  );

  if (money) {
    const settlementProperties = {
      senderMemberId: { type: 'string', format: 'uuid' },
      recipientMemberId: { type: 'string', format: 'uuid' },
      amountMinor: { type: 'integer', minimum: 1, maximum: 999999999999 },
      currency: { type: 'string', enum: ['USD', 'THB'] },
      settledOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      method: { type: 'string', maxLength: 80 },
      note: { type: 'string', maxLength: 500 },
    } as const;
    const settlementRequired = [
      'senderMemberId',
      'recipientMemberId',
      'amountMinor',
      'currency',
      'settledOn',
    ];
    const pagedQuery = {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    } as const;
    const memberParams = {
      type: 'object',
      required: ['id', 'memberId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        memberId: { type: 'string', format: 'uuid' },
      },
    } as const;
    const settlementParams = {
      type: 'object',
      required: ['id', 'settlementId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        settlementId: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.get<{ Params: { id: string } }>(
      '/v1/households/:id/balances',
      { schema: { params: idParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(await money.balances(user.id, request.params.id));
      },
    );
    app.get<{
      Params: { id: string; memberId: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/balances/:memberId/entries',
      { schema: { params: memberParams, querystring: pagedQuery } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          entries: await money.entries(
            user.id,
            request.params.id,
            request.params.memberId,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.post<{ Params: { id: string }; Body: SettlementDraft }>(
      '/v1/households/:id/settlements/preview',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: settlementRequired,
            properties: settlementProperties,
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await money.previewSettlement(
              user.id,
              request.params.id,
              request.body,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string };
      Body: SettlementDraft & { idempotencyKey: string };
    }>(
      '/v1/households/:id/settlements',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...settlementRequired, 'idempotencyKey'],
            properties: {
              ...settlementProperties,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await money.createSettlement(
              user.id,
              request.params.id,
              request.body,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.get<{
      Params: { id: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/settlements',
      { schema: { params: idParams, querystring: pagedQuery } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          settlements: await money.listSettlements(
            user.id,
            request.params.id,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; settlementId: string } }>(
      '/v1/households/:id/settlements/:settlementId',
      { schema: { params: settlementParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const settlement = await money.getSettlement(
          user.id,
          request.params.id,
          request.params.settlementId,
        );
        if (!settlement)
          throw new ApiError(404, 'NOT_FOUND', 'Transfer not found.');
        return reply.header('Cache-Control', 'no-store').send(settlement);
      },
    );
  }

  if (dashboard) {
    app.get<{ Params: { id: string } }>(
      '/v1/households/:id/dashboard',
      { schema: { params: idParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(await dashboard.get(user.id, request.params.id));
      },
    );
  }

  if (houseActions) {
    app.get<{ Params: { id: string } }>(
      '/v1/households/:id/house-actions',
      { schema: { params: idParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(await houseActions.get(user.id, request.params.id));
      },
    );
  }

  registerCommunicationRoutes(
    app,
    (request) => requireUser(request, auth),
    announcements,
    polls,
  );

  if (events) {
    const eventParams = {
      type: 'object',
      required: ['id', 'eventId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        eventId: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.get<{
      Params: { id: string };
      Querystring: { scope?: EventScope; limit?: number; offset?: number };
    }>(
      '/v1/households/:id/events',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scope: { type: 'string', enum: ['upcoming', 'past'] },
              limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          events: await events.list(
            user.id,
            request.params.id,
            request.query.scope ?? 'upcoming',
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; eventId: string } }>(
      '/v1/households/:id/events/:eventId',
      { schema: { params: eventParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const event = await events.get(
          user.id,
          request.params.id,
          request.params.eventId,
        );
        if (!event) throw new ApiError(404, 'NOT_FOUND', 'Event not found.');
        return reply.header('Cache-Control', 'no-store').send(event);
      },
    );
    app.post<{ Params: { id: string }; Body: EventDraft }>(
      '/v1/households/:id/events',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'startsAtLocal', 'idempotencyKey'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 160 },
              description: { type: 'string', maxLength: 1000 },
              location: { type: 'string', maxLength: 160 },
              startsAtLocal: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
              },
              endsAtLocal: {
                anyOf: [
                  {
                    type: 'string',
                    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
                  },
                  { type: 'null' },
                ],
              },
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(await events.create(user.id, request.params.id, request.body));
      },
    );
    app.patch<{
      Params: { id: string; eventId: string };
      Body: { response: EventResponse };
    }>(
      '/v1/households/:id/events/:eventId/attendance',
      {
        schema: {
          params: eventParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['response'],
            properties: {
              response: {
                type: 'string',
                enum: ['going', 'maybe', 'not_going'],
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await events.respond(
              user.id,
              request.params.id,
              request.params.eventId,
              request.body.response,
            ),
          );
      },
    );
  }

  if (meals) {
    const mealParams = {
      type: 'object',
      required: ['id', 'mealId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        mealId: { type: 'string', format: 'uuid' },
      },
    } as const;
    const roleSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['memberId', 'role'],
      properties: {
        memberId: { type: 'string', format: 'uuid' },
        role: { type: 'string', minLength: 1, maxLength: 60 },
      },
    } as const;
    const rolesSchema = {
      type: 'array',
      maxItems: 100,
      items: roleSchema,
    } as const;
    app.get<{
      Params: { id: string };
      Querystring: { scope?: MealListScope; limit?: number; offset?: number };
    }>(
      '/v1/households/:id/meals',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scope: {
                type: 'string',
                enum: ['all', 'reply', 'upcoming', 'past'],
              },
              limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          meals: await meals.list(
            user.id,
            request.params.id,
            request.query.scope ?? 'all',
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; mealId: string } }>(
      '/v1/households/:id/meals/:mealId',
      { schema: { params: mealParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const meal = await meals.get(
          user.id,
          request.params.id,
          request.params.mealId,
        );
        if (!meal) throw new ApiError(404, 'NOT_FOUND', 'Meal not found.');
        return reply.header('Cache-Control', 'no-store').send(meal);
      },
    );
    app.post<{ Params: { id: string }; Body: MealDraft }>(
      '/v1/households/:id/meals',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'mealType',
              'question',
              'startsAtLocal',
              'responseDeadlineLocal',
              'participantIds',
              'cookingRoles',
              'idempotencyKey',
            ],
            properties: {
              mealType: {
                type: 'string',
                enum: ['breakfast', 'lunch', 'dinner', 'other'],
              },
              question: { type: 'string', minLength: 1, maxLength: 240 },
              startsAtLocal: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
              },
              responseDeadlineLocal: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
              },
              participantIds: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'string', format: 'uuid' },
              },
              cookingRoles: rolesSchema,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(await meals.create(user.id, request.params.id, request.body));
      },
    );
    app.patch<{
      Params: { id: string; mealId: string };
      Body: { response: MealResponse };
    }>(
      '/v1/households/:id/meals/:mealId/response',
      {
        schema: {
          params: mealParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['response'],
            properties: {
              response: {
                type: 'string',
                enum: ['joining', 'not_joining', 'maybe'],
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await meals.respond(
              user.id,
              request.params.id,
              request.params.mealId,
              request.body.response,
            ),
          );
      },
    );
    app.put<{
      Params: { id: string; mealId: string };
      Body: { cookingRoles: MealRole[] };
    }>(
      '/v1/households/:id/meals/:mealId/cooking-roles',
      {
        schema: {
          params: mealParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['cookingRoles'],
            properties: { cookingRoles: rolesSchema },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await meals.setRoles(
              user.id,
              request.params.id,
              request.params.mealId,
              request.body.cookingRoles,
            ),
          );
      },
    );
  }

  if (shopping) {
    const itemParams = {
      type: 'object',
      required: ['id', 'itemId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        itemId: { type: 'string', format: 'uuid' },
      },
    } as const;
    const draftProperties = {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      quantity: {
        type: ['number', 'null'],
        minimum: 0.001,
        maximum: 999999999,
      },
      unit: { type: ['string', 'null'], maxLength: 40 },
      note: { type: ['string', 'null'], maxLength: 500 },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      assignedBuyerMemberId: { type: ['string', 'null'], format: 'uuid' },
      estimatedPriceMinor: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 999999999999,
      },
    } as const;
    const draftRequired = Object.keys(draftProperties);
    const expenseProperties = {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      amountMinor: { type: 'integer', minimum: 1, maximum: 999999999999 },
      currency: { type: 'string', enum: ['USD', 'THB'] },
      spentOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      payerMemberId: { type: 'string', format: 'uuid' },
      split: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'shares'],
        properties: {
          method: {
            type: 'string',
            enum: ['equal', 'exact', 'percentage', 'ratio'],
          },
          shares: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['memberId'],
              properties: {
                memberId: { type: 'string', format: 'uuid' },
                value: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    } as const;
    app.get<{
      Params: { id: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/shopping-items',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          items: await shopping.list(
            user.id,
            request.params.id,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; itemId: string } }>(
      '/v1/households/:id/shopping-items/:itemId',
      { schema: { params: itemParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const item = await shopping.get(
          user.id,
          request.params.id,
          request.params.itemId,
        );
        if (!item)
          throw new ApiError(404, 'NOT_FOUND', 'Shopping item not found.');
        return reply.header('Cache-Control', 'no-store').send(item);
      },
    );
    app.post<{
      Params: { id: string };
      Body: ShoppingDraft & { idempotencyKey?: string };
    }>(
      '/v1/households/:id/shopping-items',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: draftRequired,
            properties: {
              ...draftProperties,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await shopping.create(
              user.id,
              request.params.id,
              request.body,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.patch<{
      Params: { id: string; itemId: string };
      Body: ShoppingDraft & { expectedRevision: number };
    }>(
      '/v1/households/:id/shopping-items/:itemId',
      {
        schema: {
          params: itemParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...draftRequired, 'expectedRevision'],
            properties: {
              ...draftProperties,
              expectedRevision: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await shopping.edit(
              user.id,
              request.params.id,
              request.params.itemId,
              request.body,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; itemId: string };
      Body: { expectedRevision: number };
    }>(
      '/v1/households/:id/shopping-items/:itemId/cancel',
      {
        schema: {
          params: itemParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision'],
            properties: { expectedRevision: { type: 'integer', minimum: 1 } },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await shopping.cancel(
              user.id,
              request.params.id,
              request.params.itemId,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; itemId: string };
      Body: { expectedRevision: number; purchasedPriceMinor: number | null };
    }>(
      '/v1/households/:id/shopping-items/:itemId/purchase',
      {
        schema: {
          params: itemParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision', 'purchasedPriceMinor'],
            properties: {
              expectedRevision: { type: 'integer', minimum: 1 },
              purchasedPriceMinor: {
                type: ['integer', 'null'],
                minimum: 0,
                maximum: 999999999999,
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await shopping.purchase(
              user.id,
              request.params.id,
              request.params.itemId,
              request.body.expectedRevision,
              request.body.purchasedPriceMinor,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; itemId: string };
      Body: {
        expectedRevision: number;
        expenseDraft: ExpenseDraft;
        idempotencyKey: string;
      };
    }>(
      '/v1/households/:id/shopping-items/:itemId/purchase-with-expense',
      {
        schema: {
          params: itemParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision', 'expenseDraft', 'idempotencyKey'],
            properties: {
              expectedRevision: { type: 'integer', minimum: 1 },
              idempotencyKey: { type: 'string', format: 'uuid' },
              expenseDraft: {
                type: 'object',
                additionalProperties: false,
                required: Object.keys(expenseProperties),
                properties: expenseProperties,
              },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await shopping.purchaseWithExpense(
              user.id,
              request.params.id,
              request.params.itemId,
              request.body.expectedRevision,
              request.body.expenseDraft,
              request.body.idempotencyKey,
            ),
          );
      },
    );
  }

  if (chores) {
    const choreParams = {
      type: 'object',
      required: ['id', 'choreId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        choreId: { type: 'string', format: 'uuid' },
      },
    } as const;
    const swapParams = {
      type: 'object',
      required: ['id', 'choreId', 'swapId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        choreId: { type: 'string', format: 'uuid' },
        swapId: { type: 'string', format: 'uuid' },
      },
    } as const;
    const expectedRevision = { type: 'integer', minimum: 1 } as const;
    app.get<{
      Params: { id: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/chores',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          chores: await chores.list(
            user.id,
            request.params.id,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; choreId: string } }>(
      '/v1/households/:id/chores/:choreId',
      { schema: { params: choreParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const chore = await chores.get(
          user.id,
          request.params.id,
          request.params.choreId,
        );
        if (!chore) throw new ApiError(404, 'NOT_FOUND', 'Chore not found.');
        return reply.header('Cache-Control', 'no-store').send(chore);
      },
    );
    app.post<{
      Params: { id: string };
      Body: ChoreDraft & { idempotencyKey?: string };
    }>(
      '/v1/households/:id/chores',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'note', 'dueAtLocal', 'assigneeMemberId'],
            properties: {
              idempotencyKey: { type: 'string', format: 'uuid' },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              note: { type: ['string', 'null'], maxLength: 500 },
              dueAtLocal: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
              },
              assigneeMemberId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await chores.create(
              user.id,
              request.params.id,
              request.body,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.patch<{
      Params: { id: string; choreId: string };
      Body: { assigneeMemberId: string; expectedRevision: number };
    }>(
      '/v1/households/:id/chores/:choreId/assignment',
      {
        schema: {
          params: choreParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['assigneeMemberId', 'expectedRevision'],
            properties: {
              assigneeMemberId: { type: 'string', format: 'uuid' },
              expectedRevision,
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await chores.reassign(
              user.id,
              request.params.id,
              request.params.choreId,
              request.body.assigneeMemberId,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; choreId: string };
      Body: { expectedRevision: number };
    }>(
      '/v1/households/:id/chores/:choreId/complete',
      {
        schema: {
          params: choreParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision'],
            properties: { expectedRevision },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await chores.complete(
              user.id,
              request.params.id,
              request.params.choreId,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; choreId: string };
      Body: { expectedRevision: number; reason: string };
    }>(
      '/v1/households/:id/chores/:choreId/skip',
      {
        schema: {
          params: choreParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision', 'reason'],
            properties: {
              expectedRevision,
              reason: { type: 'string', minLength: 1, maxLength: 500 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await chores.skip(
              user.id,
              request.params.id,
              request.params.choreId,
              request.body.expectedRevision,
              request.body.reason,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; choreId: string };
      Body: { expectedRevision: number; targetMemberId: string };
    }>(
      '/v1/households/:id/chores/:choreId/swap-requests',
      {
        schema: {
          params: choreParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision', 'targetMemberId'],
            properties: {
              expectedRevision,
              targetMemberId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await chores.requestSwap(
              user.id,
              request.params.id,
              request.params.choreId,
              request.body.targetMemberId,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; choreId: string; swapId: string };
      Body: { expectedRevision: number; decision: 'accepted' | 'declined' };
    }>(
      '/v1/households/:id/chores/:choreId/swap-requests/:swapId/response',
      {
        schema: {
          params: swapParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedRevision', 'decision'],
            properties: {
              expectedRevision,
              decision: { type: 'string', enum: ['accepted', 'declined'] },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await chores.respondSwap(
              user.id,
              request.params.id,
              request.params.choreId,
              request.params.swapId,
              request.body.decision,
              request.body.expectedRevision,
            ),
          );
      },
    );
  }

  if (bills) {
    const adjustment = {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'kind', 'amountMinor', 'memberIds'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 160 },
        kind: {
          type: 'string',
          enum: [
            'individual_charge',
            'shared_charge',
            'individual_credit',
            'shared_credit',
          ],
        },
        amountMinor: { type: 'integer', minimum: 1, maximum: 999999999999 },
        memberIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', format: 'uuid' },
        },
      },
    } as const;
    const properties = {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      billType: {
        type: 'string',
        enum: ['electricity', 'water', 'internet', 'rent', 'other'],
      },
      provider: { type: 'string', minLength: 1, maxLength: 160 },
      amountMinor: { type: 'integer', minimum: 1, maximum: 999999999999 },
      currency: { type: 'string', enum: ['USD', 'THB'] },
      periodStart: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      periodEnd: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      payerMemberId: { type: 'string', format: 'uuid' },
      paymentStatus: { type: 'string', enum: ['unpaid', 'paid'] },
      sharedParticipantIds: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string', format: 'uuid' },
      },
      adjustments: { type: 'array', maxItems: 100, items: adjustment },
    } as const;
    const required = Object.keys(properties);
    const billParams = {
      type: 'object',
      required: ['id', 'billId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        billId: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.post<{ Params: { id: string }; Body: BillDraft }>(
      '/v1/households/:id/bills/preview',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required,
            properties,
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(await bills.preview(user.id, request.params.id, request.body));
      },
    );
    app.post<{
      Params: { id: string };
      Body: BillDraft & { idempotencyKey: string };
    }>(
      '/v1/households/:id/bills',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...required, 'idempotencyKey'],
            properties: {
              ...properties,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await bills.create(
              user.id,
              request.params.id,
              request.body,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.get<{
      Params: { id: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/bills',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          bills: await bills.list(
            user.id,
            request.params.id,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; billId: string } }>(
      '/v1/households/:id/bills/:billId',
      { schema: { params: billParams } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const bill = await bills.get(
          user.id,
          request.params.id,
          request.params.billId,
        );
        if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found.');
        return reply.header('Cache-Control', 'no-store').send(bill);
      },
    );
    app.get<{
      Params: { id: string; billId: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/bills/:billId/history',
      { schema: { params: billParams, querystring: historyQuery } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.history(
              user.id,
              request.params.id,
              request.params.billId,
              request.query.limit ?? 20,
              request.query.offset ?? 0,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; billId: string };
      Body: BillDraft & { expectedRevision: number };
    }>(
      '/v1/households/:id/bills/:billId/edit-preview',
      {
        schema: {
          params: billParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...required, 'expectedRevision'],
            properties: {
              ...properties,
              expectedRevision: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.previewEdit(
              user.id,
              request.params.id,
              request.params.billId,
              request.body,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.patch<{
      Params: { id: string; billId: string };
      Body: BillDraft & {
        expectedRevision: number;
        previewId: string;
        idempotencyKey: string;
      };
    }>(
      '/v1/households/:id/bills/:billId',
      {
        schema: {
          params: billParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              ...required,
              'expectedRevision',
              'previewId',
              'idempotencyKey',
            ],
            properties: {
              ...properties,
              expectedRevision: { type: 'integer', minimum: 1 },
              previewId: { type: 'string', format: 'uuid' },
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.edit(
              user.id,
              request.params.id,
              request.params.billId,
              request.body,
              request.body.expectedRevision,
              request.body.previewId,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.patch<{
      Params: { id: string; billId: string };
      Body: { paymentStatus: BillPaymentStatus };
    }>(
      '/v1/households/:id/bills/:billId/status',
      {
        schema: {
          params: billParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['paymentStatus'],
            properties: {
              paymentStatus: { type: 'string', enum: ['unpaid', 'paid'] },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.setStatus(
              user.id,
              request.params.id,
              request.params.billId,
              request.body.paymentStatus,
            ),
          );
      },
    );
    const voidDraftSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['expectedRevision'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        reason: { type: 'string', maxLength: 500 },
      },
    } as const;
    const voidConfirmSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['expectedRevision', 'previewId', 'idempotencyKey'],
      properties: {
        ...voidDraftSchema.properties,
        previewId: { type: 'string', format: 'uuid' },
        idempotencyKey: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.post<{
      Params: { id: string; billId: string };
      Body: { expectedRevision: number; reason?: string };
    }>(
      '/v1/households/:id/bills/:billId/void-preview',
      { schema: { params: billParams, body: voidDraftSchema } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.previewVoid(
              user.id,
              request.params.id,
              request.params.billId,
              request.body.expectedRevision,
              request.body.reason,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; billId: string };
      Body: {
        expectedRevision: number;
        reason?: string;
        previewId: string;
        idempotencyKey: string;
      };
    }>(
      '/v1/households/:id/bills/:billId/void',
      { schema: { params: billParams, body: voidConfirmSchema } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await bills.void(
              user.id,
              request.params.id,
              request.params.billId,
              request.body.expectedRevision,
              request.body.reason,
              request.body.previewId,
              request.body.idempotencyKey,
            ),
          );
      },
    );
  }

  if (expenses) {
    const expenseDraftProperties = {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      amountMinor: { type: 'integer', minimum: 1, maximum: 999999999999 },
      currency: { type: 'string', enum: ['USD', 'THB'] },
      spentOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      payerMemberId: { type: 'string', format: 'uuid' },
      split: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'shares'],
        properties: {
          method: {
            type: 'string',
            enum: ['equal', 'exact', 'percentage', 'ratio'],
          },
          shares: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['memberId'],
              properties: {
                memberId: { type: 'string', format: 'uuid' },
                value: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    } as const;
    const requiredDraft = [
      'title',
      'amountMinor',
      'currency',
      'spentOn',
      'payerMemberId',
      'split',
    ];
    app.post<{ Params: { id: string }; Body: ExpenseDraft }>(
      '/v1/households/:id/expenses/preview',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: requiredDraft,
            properties: expenseDraftProperties,
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.preview(user.id, request.params.id, request.body),
          );
      },
    );
    app.post<{
      Params: { id: string };
      Body: ExpenseDraft & { idempotencyKey: string };
    }>(
      '/v1/households/:id/expenses',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...requiredDraft, 'idempotencyKey'],
            properties: {
              ...expenseDraftProperties,
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .status(201)
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.create(
              user.id,
              request.params.id,
              request.body,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.get<{
      Params: { id: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/expenses',
      {
        schema: {
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply.header('Cache-Control', 'no-store').send({
          expenses: await expenses.list(
            user.id,
            request.params.id,
            request.query.limit ?? 50,
            request.query.offset ?? 0,
          ),
        });
      },
    );
    app.get<{ Params: { id: string; expenseId: string } }>(
      '/v1/households/:id/expenses/:expenseId',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'expenseId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              expenseId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        const expense = await expenses.get(
          user.id,
          request.params.id,
          request.params.expenseId,
        );
        if (!expense)
          throw new ApiError(404, 'NOT_FOUND', 'Expense not found.');
        return reply.header('Cache-Control', 'no-store').send(expense);
      },
    );
    const expenseParams = {
      type: 'object',
      required: ['id', 'expenseId'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        expenseId: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.get<{
      Params: { id: string; expenseId: string };
      Querystring: { limit?: number; offset?: number };
    }>(
      '/v1/households/:id/expenses/:expenseId/history',
      { schema: { params: expenseParams, querystring: historyQuery } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.history(
              user.id,
              request.params.id,
              request.params.expenseId,
              request.query.limit ?? 20,
              request.query.offset ?? 0,
            ),
          );
      },
    );
    const expenseVoidDraftSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['expectedRevision'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        reason: { type: 'string', maxLength: 500 },
      },
    } as const;
    const expenseVoidConfirmSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['expectedRevision', 'previewId', 'idempotencyKey'],
      properties: {
        ...expenseVoidDraftSchema.properties,
        previewId: { type: 'string', format: 'uuid' },
        idempotencyKey: { type: 'string', format: 'uuid' },
      },
    } as const;
    app.post<{
      Params: { id: string; expenseId: string };
      Body: { expectedRevision: number; reason?: string };
    }>(
      '/v1/households/:id/expenses/:expenseId/void-preview',
      { schema: { params: expenseParams, body: expenseVoidDraftSchema } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.previewVoid(
              user.id,
              request.params.id,
              request.params.expenseId,
              request.body.expectedRevision,
              request.body.reason,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; expenseId: string };
      Body: {
        expectedRevision: number;
        reason?: string;
        previewId: string;
        idempotencyKey: string;
      };
    }>(
      '/v1/households/:id/expenses/:expenseId/void',
      { schema: { params: expenseParams, body: expenseVoidConfirmSchema } },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.void(
              user.id,
              request.params.id,
              request.params.expenseId,
              request.body.expectedRevision,
              request.body.reason,
              request.body.previewId,
              request.body.idempotencyKey,
            ),
          );
      },
    );
    app.post<{
      Params: { id: string; expenseId: string };
      Body: ExpenseDraft & { expectedRevision: number };
    }>(
      '/v1/households/:id/expenses/:expenseId/edit-preview',
      {
        schema: {
          params: expenseParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [...requiredDraft, 'expectedRevision'],
            properties: {
              ...expenseDraftProperties,
              expectedRevision: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.previewEdit(
              user.id,
              request.params.id,
              request.params.expenseId,
              request.body,
              request.body.expectedRevision,
            ),
          );
      },
    );
    app.patch<{
      Params: { id: string; expenseId: string };
      Body: ExpenseDraft & {
        expectedRevision: number;
        previewId: string;
        idempotencyKey: string;
      };
    }>(
      '/v1/households/:id/expenses/:expenseId',
      {
        schema: {
          params: expenseParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              ...requiredDraft,
              'expectedRevision',
              'previewId',
              'idempotencyKey',
            ],
            properties: {
              ...expenseDraftProperties,
              expectedRevision: { type: 'integer', minimum: 1 },
              previewId: { type: 'string', format: 'uuid' },
              idempotencyKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(request, auth);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await expenses.edit(
              user.id,
              request.params.id,
              request.params.expenseId,
              request.body,
              request.body.expectedRevision,
              request.body.previewId,
              request.body.idempotencyKey,
            ),
          );
      },
    );
  }

  return app;
}
