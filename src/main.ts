import { loadConfig } from './config.js';
import { reportError } from './error-reporting.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const { app, runner } = createRuntime(config);
let timer: ReturnType<typeof setInterval> | undefined;
const runNotifications = () => {
  void runner.run().catch(async (error) => {
    await reportError(error, 'api.notifications');
    app.log.error(
      'Notification worker failed; the next scheduled run will retry.',
    );
  });
};
app.addHook('preClose', async () => {
  if (timer) clearInterval(timer);
});

try {
  await app.listen({ port: config.port, host: config.host });
  if (!config.serverless) {
    runNotifications();
    timer = setInterval(runNotifications, 60_000);
    timer.unref();
  }
} catch (error) {
  await reportError(error, 'api.startup');
  app.log.error('API startup failed. Check server configuration.');
  process.exitCode = 1;
  await app.close();
}
