import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DeliveryHealth } from './notification-health.js';

export function createNotificationRunner(tick: () => Promise<void>) {
  let pending: Promise<void> | null = null;
  let requested = false;
  return {
    async run(followUp = false): Promise<boolean> {
      if (pending) {
        if (followUp) requested = true;
        return false;
      }
      pending = Promise.resolve().then(async () => {
        requested = false;
        await tick();
        // A save committed after the queue snapshot needs another pass.
        // Bound follow-ups; the durable scheduler handles any continuing traffic.
        if (requested) {
          requested = false;
          await tick();
        }
      });
      try {
        await pending;
        return true;
      } finally {
        pending = null;
      }
    },
    async drain() {
      await pending?.catch(() => {});
    },
  };
}

export function registerNotificationJob(
  app: FastifyInstance,
  secret: string | null,
  run: () => Promise<boolean>,
  reportError: (
    error: unknown,
    operation: string,
  ) => Promise<void> = async () => {},
  health?: () => Promise<DeliveryHealth>,
) {
  const expected = secret
    ? createHash('sha256').update(`Bearer ${secret}`).digest()
    : null;
  if (health)
    app.get('/internal/notifications/health', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const supplied = createHash('sha256')
        .update(request.headers.authorization ?? '')
        .digest();
      if (!expected || !timingSafeEqual(expected, supplied))
        return reply.code(401).send({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Invalid job credentials.',
          },
        });
      try {
        const delivery = await health();
        return reply
          .code(delivery.healthy ? 200 : 503)
          .send({ status: delivery.healthy ? 'ok' : 'degraded', delivery });
      } catch {
        return reply.code(503).send({
          error: {
            code: 'HEALTH_UNAVAILABLE',
            message: 'Delivery health unavailable.',
          },
        });
      }
    });
  app.get('/internal/notifications/run', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const supplied = createHash('sha256')
      .update(request.headers.authorization ?? '')
      .digest();
    if (!expected || !timingSafeEqual(expected, supplied)) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Invalid job credentials.' },
      });
    }
    try {
      if (!(await run())) {
        return reply
          .header('Retry-After', '60')
          .code(503)
          .send({
            error: {
              code: 'JOB_BUSY',
              message: 'Notification job is running.',
            },
          });
      }
      const delivery = await health?.();
      if (delivery && !delivery.healthy) {
        await reportError(
          new Error('Notification queue delayed or delivery failed'),
          'api.notifications.delivery',
        ).catch(() => {});
        return reply.code(503).send({ status: 'degraded', delivery });
      }
      return delivery ? { status: 'ok', delivery } : { status: 'ok' };
    } catch (error) {
      // Database/provider errors may contain private connection details.
      request.log.error('Scheduled notification job failed.');
      await reportError(error, 'api.notifications').catch(() => {});
      return reply.code(503).send({
        error: {
          code: 'JOB_FAILED',
          message: 'Notification job failed; retry later.',
        },
      });
    }
  });
}
