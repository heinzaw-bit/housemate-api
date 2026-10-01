import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  normalizeSearch,
  type SearchInput,
  type SearchRepository,
  searchTypes,
} from './search.js';
import type { AuthenticatedUser } from './types.js';

export function registerSearchRoutes(
  app: FastifyInstance,
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>,
  search?: SearchRepository,
) {
  if (!search) return;
  app.get<{ Params: { id: string }; Querystring: SearchInput }>(
    '/v1/households/:id/search',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 120 },
            type: { type: 'string', enum: ['all', ...searchTypes] },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const user = await authenticate(request);
      normalizeSearch(request.query);
      return search.search(user.id, request.params.id, request.query);
    },
  );
}
