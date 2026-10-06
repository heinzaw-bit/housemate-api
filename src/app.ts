import { waitUntil } from '@vercel/functions';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { reportError } from './error-reporting.js';
import { createRuntime } from './runtime.js';

// Vercel detects this Fastify entry point. No background interval runs here.
const config = loadConfig();
// The detected entry point must import Fastify directly for Vercel's builder.
const { app } = createRuntime(config, Fastify, waitUntil);
// Vercel intercepts listen(); do not block module loading on that promise.
app.listen({ port: config.port, host: '0.0.0.0' }).catch(async (error) => {
  app.log.error('API startup failed.');
  await reportError(error, 'api.startup');
  process.exitCode = 1;
});
