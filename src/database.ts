import type { PoolConfig } from 'pg';
import type { Config } from './config.js';

export function databasePoolOptions(config: Config): PoolConfig {
  if (!config.serverless) {
    return { connectionString: config.databaseUrl, max: 10 };
  }
  // URL SSL options override pg's ssl object. Use our verified TLS settings.
  const connection = new URL(config.databaseUrl);
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    connection.searchParams.delete(key);
  }
  return {
    connectionString: connection.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: config.databaseSslCa },
  };
}
