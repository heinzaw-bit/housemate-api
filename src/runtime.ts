import type Fastify from 'fastify';
import pg from 'pg';
import { PgAnnouncementRepository } from './announcements.js';
import { createApp } from './application.js';
import { HouseholdAssistant } from './assistant.js';
import { PgAssistantBudget } from './assistant-budget.js';
import { GeminiAssistantProvider } from './assistant-provider.js';
import { createSupabaseAuthVerifier } from './auth.js';
import { PgBillRepository } from './bills.js';
import { PgChoreRepository } from './chores.js';
import type { Config } from './config.js';
import { PgDashboardRepository } from './dashboard.js';
import { databasePoolOptions } from './database.js';
import { initializeErrorReporting, reportError } from './error-reporting.js';
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
import { PgSearchRepository } from './search.js';
import { PgShoppingRepository } from './shopping.js';

export function createRuntime(config: Config, fastifyFactory?: typeof Fastify) {
  initializeErrorReporting();
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
    fastifyFactory,
    auth: createSupabaseAuthVerifier(
      config.supabaseUrl,
      config.supabasePublishableKey,
    ),
    households: new PgHouseholdRepository(pool),
    assistant: new HouseholdAssistant(
      {
        households: new PgHouseholdRepository(pool),
        dashboard: new PgDashboardRepository(pool),
        shopping: new PgShoppingRepository(pool),
        chores: new PgChoreRepository(pool),
        meals: new PgMealRepository(pool),
        events: new PgEventRepository(pool),
        announcements: new PgAnnouncementRepository(pool),
      },
      config.assistant
        ? new GeminiAssistantProvider(config.assistant.apiKey)
        : null,
      config.assistant ? new PgAssistantBudget(pool) : null,
    ),
    expenses: new PgExpenseRepository(pool),
    bills: new PgBillRepository(pool),
    money: new PgMoneyRepository(pool),
    dashboard: new PgDashboardRepository(pool),
    houseActions: new PgHouseActionRepository(pool),
    search: new PgSearchRepository(pool),
    meals: new PgMealRepository(pool),
    shopping: new PgShoppingRepository(pool),
    chores: new PgChoreRepository(pool),
    events: new PgEventRepository(pool),
    announcements: new PgAnnouncementRepository(pool),
    polls: new PgPollRepository(pool),
    notifications: new PgNotificationRepository(pool, pushConfig),
    pushConfig,
    webOrigins: config.webOrigins,
    reportError,
    readiness: async () => {
      const query = { text: 'SELECT 1', query_timeout: 5000 };
      await pool.query(query);
    },
  });

  const runner = createNotificationRunner(() => worker.tick());
  registerNotificationJob(
    app,
    config.cronSecret,
    () => runner.run(),
    reportError,
  );
  app.addHook('onClose', async () => {
    await runner.drain();
    await pool.end();
  });
  pool.on('error', (error) => {
    app.log.error('Idle database connection failed.');
    void reportError(error, 'api.database');
  });
  return { app, runner };
}
