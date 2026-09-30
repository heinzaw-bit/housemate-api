import pg from 'pg';
import { PgAnnouncementRepository } from './announcements.js';
import { createApp } from './application.js';
import { createSupabaseAuthVerifier } from './auth.js';
import { PgBillRepository } from './bills.js';
import { PgChoreRepository } from './chores.js';
import type { Config } from './config.js';
import { PgDashboardRepository } from './dashboard.js';
import { databasePoolOptions } from './database.js';
import { PgEventRepository } from './events.js';
import { PgExpenseRepository } from './expenses.js';
import { PgHouseActionRepository } from './house-actions.js';
import { PgHouseholdRepository } from './households.js';
import { PgMealRepository } from './meals.js';
import { PgMoneyRepository } from './money.js';
import {
  createNotificationRunner,
  registerNotificationJob,
} from './notification-job.js';
import { createPushSender, NotificationWorker } from './notification-worker.js';
import { PgNotificationRepository, type PushConfig } from './notifications.js';
import { PgPollRepository } from './polls.js';
import { PgShoppingRepository } from './shopping.js';

export function createRuntime(config: Config) {
  const pool = new pg.Pool(databasePoolOptions(config));
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

  const runner = createNotificationRunner(() => worker.tick());
  registerNotificationJob(app, config.cronSecret, () => runner.run());
  app.addHook('onClose', async () => {
    await runner.drain();
    await pool.end();
  });
  pool.on('error', () => app.log.error('Idle database connection failed.'));
  return { app, runner };
}
