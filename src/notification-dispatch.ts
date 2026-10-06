import type { FastifyInstance } from 'fastify';

// Only committed household record writes can wake the queue. Previews/read markers do not.
export function shouldDispatch(
  method: string,
  path: string,
  status: number,
): boolean {
  return (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    status >= 200 &&
    status < 300 &&
    /^\/v1\/households\/[^/]+\/(announcements|events|expenses|bills|settlements|meals|chores|shopping-items|polls)(?:\/|$)/.test(
      path,
    ) &&
    !/(?:preview|calculate)(?:\/|$)/.test(path)
  );
}
export function registerImmediateDispatch(
  app: FastifyInstance,
  run: () => Promise<unknown>,
  schedule: (task: Promise<unknown>) => void,
  report: (error: unknown, operation: string) => Promise<void>,
) {
  app.addHook('onResponse', async (request, reply) => {
    if (
      !shouldDispatch(
        request.method,
        request.routeOptions.url ?? '',
        reply.statusCode,
      )
    )
      return;
    const task = Promise.resolve()
      .then(run)
      .catch((error) => report(error, 'api.notifications'));
    // Lifetime is owned by Vercel waitUntil in production, never an untracked timer.
    try {
      schedule(task);
    } catch {
      await task;
    }
  });
}
