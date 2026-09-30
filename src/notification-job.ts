import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export function createNotificationRunner(tick: () => Promise<void>) {
  let pending: Promise<void> | null = null;
  return {
    async run(): Promise<boolean> {
      if (pending) return false;
      pending = Promise.resolve().then(tick);
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
) {
  const expected = secret
    ? createHash('sha256').update(`Bearer ${secret}`).digest()
    : null;
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
      return { status: 'ok' };
    } catch {
      // Database/provider errors may contain private connection details.
      request.log.error('Scheduled notification job failed.');
      return reply.code(503).send({
        error: {
          code: 'JOB_FAILED',
          message: 'Notification job failed; retry later.',
        },
      });
    }
  });
}
