import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

// Vercel detects this Fastify entry point. No background interval runs here.
const config = loadConfig();
const { app } = createRuntime(config);
await app.listen({ port: config.port, host: '0.0.0.0' });
