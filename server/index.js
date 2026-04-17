import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import pg from 'pg';
import Redis from 'ioredis';
import { requireAuth } from './middleware/auth.js';

const { Pool } = pg;

// ---------- Database clients ----------
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redis = new Redis(process.env.REDIS_URL);

// ---------- Fastify app ----------
const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    },
  },
});

await app.register(websocket);

// ---------- Routes ----------
app.get('/', async () => ({
  name: 'blingl-chat',
  version: '0.1.0',
  message: 'hello from the Blingl chat server',
}));

app.get('/health', async (request, reply) => {
  const checks = { postgres: 'unknown', redis: 'unknown' };

  try {
    const result = await pgPool.query('SELECT 1 as ok');
    checks.postgres = result.rows[0].ok === 1 ? 'ok' : 'fail';
  } catch (err) {
    checks.postgres = `fail: ${err.message}`;
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'fail';
  } catch (err) {
    checks.redis = `fail: ${err.message}`;
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  reply.code(allOk ? 200 : 503);
  return { status: allOk ? 'ok' : 'degraded', checks };
});
// Temporary: verifies JWT auth works end-to-end. Remove after Phase 2.1 testing.
app.get('/whoami', { preHandler: requireAuth }, async (request) => ({
  userId: request.userId,
  email: request.userEmail,
  role: request.userRole,
}));
// Echo WebSocket — proves the WS layer works
app.get('/ws', { websocket: true }, (socket, request) => {
  app.log.info('WebSocket client connected');
  socket.send(JSON.stringify({ type: 'hello', message: 'connected' }));

  socket.on('message', (raw) => {
    const text = raw.toString();
    app.log.info({ text }, 'WS message received');
    socket.send(JSON.stringify({ type: 'echo', received: text }));
  });

  socket.on('close', () => {
    app.log.info('WebSocket client disconnected');
  });
});

// ---------- Boot ----------
const PORT = Number(process.env.PORT) || 3000;

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pgPool.end();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));