export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  webOrigins: string[];
  serverless: boolean;
  cronSecret: string | null;
  databaseSslCa: string | undefined;
  assistant?: { apiKey: string } | null;
  vapid: { subject: string; publicKey: string; privateKey: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serverless = env.VERCEL === '1';
  const cronSecret = env.CRON_SECRET || null;
  if (cronSecret && !/^[A-Za-z0-9_-]{32,256}$/.test(cronSecret)) {
    throw new Error('CRON_SECRET must contain 32–256 URL-safe characters');
  }
  if (serverless && !cronSecret) {
    throw new Error('CRON_SECRET is required on Vercel');
  }
  const databaseUrl = requireValue(env.DATABASE_URL, 'DATABASE_URL');
  const supabaseUrl = requireValue(env.SUPABASE_URL, 'SUPABASE_URL');
  const supabasePublishableKey = requireValue(
    env.SUPABASE_PUBLISHABLE_KEY,
    'SUPABASE_PUBLISHABLE_KEY',
  );
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  const url = new URL(supabaseUrl);
  if (
    url.protocol !== 'https:' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1'
  ) {
    throw new Error('SUPABASE_URL must use HTTPS outside localhost');
  }
  const webOrigins = (
    serverless
      ? requireValue(env.WEB_ORIGINS, 'WEB_ORIGINS')
      : (env.WEB_ORIGINS ?? 'http://localhost:3000')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    webOrigins.length === 0 ||
    webOrigins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.origin !== origin ||
          (parsed.protocol !== 'https:' &&
            parsed.hostname !== 'localhost' &&
            parsed.hostname !== '127.0.0.1')
        );
      } catch {
        return true;
      }
    })
  ) {
    throw new Error(
      'WEB_ORIGINS must contain exact HTTPS origins, or localhost origins for development',
    );
  }
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    databaseUrl,
    supabaseUrl: url.origin,
    supabasePublishableKey,
    webOrigins,
    serverless,
    cronSecret,
    databaseSslCa: env.DATABASE_SSL_CA || undefined,
    assistant:
      env.GEMINI_API_KEY?.trim() && env.GEMINI_FREE_TIER_CONFIRMED === 'true'
        ? {
            apiKey: env.GEMINI_API_KEY.trim(),
          }
        : null,
    vapid:
      env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? validatedVapid(
            env.VAPID_SUBJECT,
            env.VAPID_PUBLIC_KEY,
            env.VAPID_PRIVATE_KEY,
          )
        : null,
  };
}

function validatedVapid(
  subject: string,
  publicKey: string,
  privateKey: string,
) {
  const uri = new URL(subject);
  if (
    !['mailto:', 'https:'].includes(uri.protocol) ||
    (uri.protocol === 'https:' &&
      ['localhost', '127.0.0.1'].includes(uri.hostname))
  )
    throw new Error(
      'VAPID_SUBJECT must be a real public contact mailto: address or HTTPS support URL',
    );
  return { subject, publicKey, privateKey };
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
