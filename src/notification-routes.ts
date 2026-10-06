import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type NotificationPreferences,
  type NotificationRepository,
  notificationCategories,
  type PushConfig,
  type PushRegistration,
} from './notifications.js';
import type { PushTestService } from './push-test.js';
import type { AuthenticatedUser } from './types.js';

export function registerNotificationRoutes(
  app: FastifyInstance,
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>,
  repo: NotificationRepository | undefined,
  push: PushConfig,
  tests?: PushTestService,
) {
  if (!repo) return;
  const householdParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  };
  const itemParams = {
    ...householdParams,
    required: ['id', 'notificationId'],
    properties: {
      ...householdParams.properties,
      notificationId: { type: 'string', format: 'uuid' },
    },
  };
  app.get<{
    Params: { id: string };
    Querystring: { scope?: 'all' | 'unread'; limit?: number; cursor?: string };
  }>(
    '/v1/households/:id/notifications',
    {
      schema: {
        params: householdParams,
        querystring: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['all', 'unread'] },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            cursor: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await repo.list(
            user.id,
            request.params.id,
            request.query.scope ?? 'all',
            request.query.limit ?? 20,
            request.query.cursor,
          ),
        );
    },
  );
  app.put<{ Params: { id: string; notificationId: string } }>(
    '/v1/households/:id/notifications/:notificationId/read',
    { schema: { params: itemParams } },
    async (request, reply) => {
      const user = await authenticate(request);
      await repo.markRead(
        user.id,
        request.params.id,
        request.params.notificationId,
      );
      return reply.header('Cache-Control', 'no-store').status(204).send();
    },
  );
  app.post<{ Params: { id: string }; Body: { throughId: string } }>(
    '/v1/households/:id/notifications/read-all',
    {
      schema: {
        params: householdParams,
        body: {
          type: 'object',
          required: ['throughId'],
          additionalProperties: false,
          properties: { throughId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      await repo.markAllRead(
        user.id,
        request.params.id,
        request.body.throughId,
      );
      return reply.header('Cache-Control', 'no-store').status(204).send();
    },
  );
  const channels = {
    type: 'object',
    required: ['inApp', 'webPush'],
    additionalProperties: false,
    properties: { inApp: { type: 'boolean' }, webPush: { type: 'boolean' } },
  };
  const preferencesSchema = {
    type: 'object',
    required: ['categories', 'quietHours'],
    additionalProperties: false,
    properties: {
      categories: {
        type: 'object',
        required: [...notificationCategories],
        additionalProperties: false,
        properties: Object.fromEntries(
          notificationCategories.map((category) => [category, channels]),
        ),
      },
      quietHours: {
        type: 'object',
        required: ['enabled', 'start', 'end'],
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        },
      },
    },
  };
  app.get<{ Params: { id: string } }>(
    '/v1/households/:id/notification-preferences',
    { schema: { params: householdParams } },
    async (request, reply) => {
      const user = await authenticate(request);
      return reply
        .header('Cache-Control', 'no-store')
        .send(await repo.preferences(user.id, request.params.id));
    },
  );
  app.put<{
    Params: { id: string };
    Body: Omit<NotificationPreferences, 'timezone'>;
  }>(
    '/v1/households/:id/notification-preferences',
    { schema: { params: householdParams, body: preferencesSchema } },
    async (request, reply) => {
      const user = await authenticate(request);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await repo.savePreferences(user.id, request.params.id, request.body),
        );
    },
  );
  if (tests)
    app.post<{ Params: { id: string; subscriptionId: string } }>(
      '/v1/households/:id/push-subscriptions/:subscriptionId/test',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'subscriptionId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              subscriptionId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
      async (request, reply) => {
        const user = await authenticate(request);
        return reply
          .header('Cache-Control', 'no-store')
          .send(
            await tests.send(
              user.id,
              request.params.id,
              request.params.subscriptionId,
            ),
          );
      },
    );
  app.get('/v1/push-config', async (request, reply) => {
    await authenticate(request);
    return reply.header('Cache-Control', 'no-store').send(push);
  });
  app.get('/v1/push-subscriptions', async (request, reply) => {
    const user = await authenticate(request);
    return reply
      .header('Cache-Control', 'no-store')
      .send({ devices: await repo.devices(user.id) });
  });
  app.post<{ Body: PushRegistration }>(
    '/v1/push-subscriptions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint', 'keys'],
          additionalProperties: false,
          properties: {
            endpoint: { type: 'string', format: 'uri', maxLength: 2048 },
            refreshOnly: { type: 'boolean' },
            keys: {
              type: 'object',
              required: ['p256dh', 'auth'],
              additionalProperties: false,
              properties: {
                p256dh: { type: 'string', minLength: 80, maxLength: 100 },
                auth: { type: 'string', minLength: 20, maxLength: 30 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      return reply
        .header('Cache-Control', 'no-store')
        .send(await repo.subscribe(user.id, request.body));
    },
  );
  app.delete<{ Params: { subscriptionId: string } }>(
    '/v1/push-subscriptions/:subscriptionId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['subscriptionId'],
          properties: { subscriptionId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      await repo.unsubscribe(user.id, request.params.subscriptionId);
      return reply.header('Cache-Control', 'no-store').status(204).send();
    },
  );
}
