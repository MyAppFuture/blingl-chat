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

// GET /conversations — list the current user's conversations
app.get('/conversations', { preHandler: requireAuth }, async (request, reply) => {
  const userId = request.userId;

  // Parse + validate query params
  const cursor = request.query.cursor ?? null;
  const limit = Math.min(Number(request.query.limit) || 20, 100);

  // If a cursor was provided, make sure it's a valid date
  if (cursor !== null && Number.isNaN(Date.parse(cursor))) {
    return reply.code(400).send({ error: 'invalid cursor' });
  }

  const result = await pgPool.query(
    `
    SELECT
      c.id,
      CASE
        WHEN c.user_a_id = $1 THEN c.user_b_id
        ELSE c.user_a_id
      END AS other_user_id,
      c.last_message_at,
      c.last_message_preview,
      c.created_at,
      (
        SELECT COUNT(*)::int
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id <> $1
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM message_reads r
            WHERE r.message_id = m.id AND r.user_id = $1
          )
      ) AS unread_count
    FROM conversations c
    WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
      AND ($2::timestamptz IS NULL OR c.last_message_at < $2)
    ORDER BY c.last_message_at DESC
    LIMIT $3 + 1
    `,
    [userId, cursor, limit]
  );

  const allRows = result.rows;
  const hasMore = allRows.length > limit;
  const rows = hasMore ? allRows.slice(0, limit) : allRows;
  const nextCursor = hasMore ? rows[rows.length - 1].last_message_at : null;

  return {
    conversations: rows,
    nextCursor,
  };
});

// GET /conversations/:id/messages — load messages in a conversation
app.get('/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
  const userId = request.userId;
  const conversationId = request.params.id;

  // Validate UUID format early — saves a roundtrip
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(conversationId)) {
    return reply.code(400).send({ error: 'invalid conversation id' });
  }

  // Parse query params
  const cursorRaw = request.query.cursor ?? null;
  const afterSequenceRaw = request.query.afterSequence ?? null;
  const limit = Math.min(Number(request.query.limit) || 50, 100);

  // Both cursor and afterSequence must be valid non-negative integers if provided
  const cursor = cursorRaw === null ? null : Number(cursorRaw);
  const afterSequence = afterSequenceRaw === null ? null : Number(afterSequenceRaw);

  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 0)) {
    return reply.code(400).send({ error: 'invalid cursor' });
  }
  if (afterSequence !== null && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
    return reply.code(400).send({ error: 'invalid afterSequence' });
  }

  // Authorization check: is this user a participant?
  const authCheck = await pgPool.query(
    `SELECT 1 FROM conversations
     WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
    [conversationId, userId]
  );

  if (authCheck.rowCount === 0) {
    // We return 404 rather than 403 to avoid leaking existence of conversations
    return reply.code(404).send({ error: 'conversation not found' });
  }

  // Two pagination modes:
  //   afterSequence → replay (ASC order, sequence > N)
  //   cursor/nothing → scrollback (DESC order, sequence < cursor)
  let sql;
  let params;

  if (afterSequence !== null) {
    sql = `
      SELECT
        m.id, m.sender_id, m.sequence_number, m.client_nonce, m.content,
        m.message_type, m.reply_to_id, m.created_at, m.edited_at, m.deleted_at,
        COALESCE(
          (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
           FROM message_reactions r WHERE r.message_id = m.id),
          '[]'::json
        ) AS reactions,
        COALESCE(
          (SELECT json_agg(reads.user_id)
           FROM message_reads reads WHERE reads.message_id = m.id),
          '[]'::json
        ) AS read_by
      FROM messages m
      WHERE m.conversation_id = $1
        AND m.sequence_number > $2
      ORDER BY m.sequence_number ASC
      LIMIT $3 + 1
    `;
    params = [conversationId, afterSequence, limit];
  } else {
    sql = `
      SELECT
        m.id, m.sender_id, m.sequence_number, m.client_nonce, m.content,
        m.message_type, m.reply_to_id, m.created_at, m.edited_at, m.deleted_at,
        COALESCE(
          (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
           FROM message_reactions r WHERE r.message_id = m.id),
          '[]'::json
        ) AS reactions,
        COALESCE(
          (SELECT json_agg(reads.user_id)
           FROM message_reads reads WHERE reads.message_id = m.id),
          '[]'::json
        ) AS read_by
      FROM messages m
      WHERE m.conversation_id = $1
        AND ($2::bigint IS NULL OR m.sequence_number < $2)
      ORDER BY m.sequence_number DESC
      LIMIT $3 + 1
    `;
    params = [conversationId, cursor, limit];
  }

  const result = await pgPool.query(sql, params);

  const allRows = result.rows;
  const hasMore = allRows.length > limit;
  const messages = hasMore ? allRows.slice(0, limit) : allRows;

  // nextCursor semantics depend on mode:
  //   scrollback (DESC): cursor = smallest sequence_number seen → ask for older
  //   replay (ASC):       cursor = largest sequence_number seen → ask for newer
  let nextCursor = null;
  if (hasMore) {
    const last = messages[messages.length - 1];
    nextCursor = last.sequence_number;
  }

  return {
    messages,
    nextCursor,
  };
});

// GET /unread-counts — per-conversation unread counts for the current user
// Cached in Redis with 30s TTL (see build plan Phase 2.4)
app.get('/unread-counts', { preHandler: requireAuth }, async (request, reply) => {
  const userId = request.userId;
  const cacheKey = `unread:${userId}`;

  // Cache-aside: try Redis first
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.header('x-cache', 'hit');
      return JSON.parse(cached);
    }
  } catch (err) {
    // Redis failed — log and fall through to Postgres.
    // Cache is an optimization, not a dependency.
    request.log.warn({ err }, 'redis get failed, falling through to db');
  }

  // Cache miss: query Postgres
  const result = await pgPool.query(
    `
    SELECT
      c.id AS conversation_id,
      COUNT(m.id)::int AS unread_count
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
      AND m.sender_id <> $1
      AND m.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM message_reads r
        WHERE r.message_id = m.id AND r.user_id = $1
      )
    GROUP BY c.id
    HAVING COUNT(m.id) > 0
    `,
    [userId]
  );

  // Shape as { conversationId: count } object for easy client lookup
  const counts = {};
  let total = 0;
  for (const row of result.rows) {
    counts[row.conversation_id] = row.unread_count;
    total += row.unread_count;
  }

  const payload = { counts, total };

  // Store in Redis with 30s TTL. Fire-and-forget — don't block the response on it.
  redis.set(cacheKey, JSON.stringify(payload), 'EX', 30).catch((err) => {
    request.log.warn({ err }, 'redis set failed');
  });

  reply.header('x-cache', 'miss');
  return payload;
});

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