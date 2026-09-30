import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

// Vercel detects this Fastify entry point. No background interval runs here.
const config = loadConfig();
// The detected entry point must import Fastify directly for Vercel's builder.
const { app } = createRuntime(config, Fastify);
await app.listen({ port: config.port, host: '0.0.0.0' });
