import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const { app, runner } = createRuntime(config);
let timer: ReturnType<typeof setInterval> | undefined;
const runNotifications = () => {
  void runner.run().catch(() => {
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
} catch {
  app.log.error('API startup failed. Check server configuration.');
  process.exitCode = 1;
  await app.close();
}
