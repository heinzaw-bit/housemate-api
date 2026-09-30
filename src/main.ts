import pg from 'pg';
import { PgAnnouncementRepository } from './announcements.js';
import { createApp } from './app.js';
import { createSupabaseAuthVerifier } from './auth.js';
import { PgBillRepository } from './bills.js';
import { PgChoreRepository } from './chores.js';
import { loadConfig } from './config.js';
import { PgDashboardRepository } from './dashboard.js';
import { PgEventRepository } from './events.js';
import { PgExpenseRepository } from './expenses.js';
import { PgHouseActionRepository } from './house-actions.js';
import { PgHouseholdRepository } from './households.js';
import { PgMealRepository } from './meals.js';
import { PgMoneyRepository } from './money.js';
import { createPushSender, NotificationWorker } from './notification-worker.js';
import { PgNotificationRepository, type PushConfig } from './notifications.js';
import { PgPollRepository } from './polls.js';
import { PgShoppingRepository } from './shopping.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const pushConfig: PushConfig = {
  enabled: !!config.vapid,
  publicKey: config.vapid?.publicKey ?? null,
  reason: config.vapid ? null : 'server_setup',
};
const worker = new NotificationWorker(
  pool,
  config.vapid ? createPushSender(config.vapid) : null,
  pushConfig.publicKey,
);
const app = createApp({
  auth: createSupabaseAuthVerifier(
    config.supabaseUrl,
    config.supabasePublishableKey,
  ),
  households: new PgHouseholdRepository(pool),
  expenses: new PgExpenseRepository(pool),
  bills: new PgBillRepository(pool),
  money: new PgMoneyRepository(pool),
  dashboard: new PgDashboardRepository(pool),
  houseActions: new PgHouseActionRepository(pool),
  meals: new PgMealRepository(pool),
  shopping: new PgShoppingRepository(pool),
  chores: new PgChoreRepository(pool),
  events: new PgEventRepository(pool),
  announcements: new PgAnnouncementRepository(pool),
  polls: new PgPollRepository(pool),
  notifications: new PgNotificationRepository(pool, pushConfig),
  pushConfig,
  webOrigins: config.webOrigins,
});

let tick: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setInterval> | undefined;
let notificationRunning = false;
const runNotifications = () => {
  if (notificationRunning) return;
  notificationRunning = true;
  tick = worker
    .tick()
    .catch(() => {
      app.log.error(
        'Notification worker failed; the next scheduled run will retry.',
      );
    })
    .finally(() => {
      notificationRunning = false;
    });
};
app.addHook('onClose', async () => {
  if (timer) clearInterval(timer);
  await tick;
  await pool.end();
});

try {
  await app.listen({ port: config.port, host: config.host });
  runNotifications();
  timer = setInterval(runNotifications, 60_000);
  timer.unref();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
