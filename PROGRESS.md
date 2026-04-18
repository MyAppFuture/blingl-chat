# Blingl Chat — Progress Log

Track where you are between sessions. Update this file at the end of every work session.

## Current Status

**Current Phase:** Phase 2 complete ✅ + Phase 2.5 complete ✅
**Current Step:** Ready to start Phase 3 — REST API, Write Operations
**Last session date:** 2026-04-18
**Next action:** Phase 3.1 — POST /conversations/:id/messages (idempotent send with client_nonce, atomic sequence_number allocation via UPDATE...RETURNING, block check, server-authoritative timestamps, update conversation's last_message_at + last_message_preview on write)

### Session 4 — 2026-04-18 (late evening)

**Duration:** ~4 hours
**Phase:** 2 — REST API, Read Operations (complete) + Phase 2.5 (template extracted)

**Completed:**
- Reseeded DB with real Supabase UUID (pakys997@gmail.com) as "Alice"
- Phase 2.2: `GET /conversations`
  - Parameterized SQL via pgPool.query() ($1, $2, $3), CASE for other_user_id
  - Cursor pagination (last_message_at < $2 with IS NULL first-page guard)
  - LIMIT $3 + 1 peek-ahead for accurate nextCursor (no wasted empty-page requests)
  - unread_count as correlated subquery with NOT EXISTS anti-join against message_reads
  - ::int cast on COUNT to avoid BIGINT-as-string in JSON
- Phase 2.3: `GET /conversations/:id/messages`
  - UUID format validation before DB query
  - Authorization check returns 404 (not 403) on non-participant — no existence leak
  - Two pagination modes: scrollback (DESC, cursor < N) and reconnect replay (ASC, afterSequence > N)
  - Reactions and read_by aggregated via json_agg + json_build_object — single round trip
  - COALESCE(..., '[]'::json) for clean empty arrays
  - Kept sequence_number as BIGINT-as-string in JSON (safer at scale)
- Phase 2.4: `GET /unread-counts`
  - Cache-aside pattern: Redis first (30s TTL), Postgres fallback
  - Key format `unread:<userId>`
  - Fire-and-forget cache write (.catch without await)
  - Graceful degradation on Redis failure (log + fallthrough, no error)
  - x-cache response header ('hit' | 'miss') for debugging
- First real JWT via Supabase magic link with redirect_to=localhost:9999 hack (dead port keeps token visible in URL bar after redirect)
- Verified end-to-end: 401 on no-auth, 400 on bad cursor, 404 on non-participant, 200 + correct data on valid requests
- Phase 2.5: Extracted blingl-service-template
  - Copied chat repo, reset .git, stripped chat-specific code (routes, schema, migrations, seed, WebSocket)
  - Genericized names: blingl_chat → blingl_service, devpassword123 → changeme
  - Added README documenting what template provides, standards, how to spin up new services
  - Empty PROGRESS.md template for future services
  - Pushed to github.com/MyAppFuture/blingl-service-template
  - Smoke-tested: docker compose up, /health → 200, /whoami → 401, clean shutdown

**Blockers / Issues (resolved):**
- Initial nextCursor logic (rows.length === limit) returned non-null on last page — fixed with LIMIT + 1 peek-ahead
- Magic link redirect to http://localhost:3000 made browser discard URL fragment — fixed by redirecting to dead port 9999
- Accidentally deleted /conversations route while adding /conversations/:id/messages — caught before testing
- Template's .env.example initially contained literal heredoc text (`cat > ... << 'EOF'`) — fixed
- Multiple typos in docker-compose.yml during edit (changame, blingl_servece) — caught and fixed
- First push of template failed because commit hadn't happened yet — order matters: add → commit → push

**Notes:**
- Supabase access tokens expire in 1 hour. iOS will refresh automatically in Phase 8
- LIMIT + 1 peek-ahead pattern is reusable — applies to both /conversations and /conversations/:id/messages
- All three endpoints avoid N+1: conversations + unread_count (correlated subquery), messages + reactions + reads (json_agg), unread-counts (single JOIN + GROUP BY)
- Template is frozen at extraction point — no WebSocket, no rate limiting, no Sentry. Those belong to specific services or the Phase 6.5 realtime template.
- CHECKPOINT 2 met: full REST reads, auth on every endpoint, cursor pagination throughout
- CHECKPOINT 2.5 met: two working repos, template smoke-tested

**Next session I'll:**
- Phase 3.1: POST /conversations/:id/messages (idempotent send with client_nonce + sequence allocator)
- Phase 3.2-3.6: edit, delete, reactions, read receipts, start conversation

---

## Session Log (most recent first)

### Session 3 — 2026-04-17 (late evening)

**Duration:** ~1 hour
**Phase:** 2 — REST API, Read Operations (2.1 complete)

**Completed:**
- Installed `jose` (v6) in `server/`
- Wrote `server/middleware/auth.js` — `requireAuth` Fastify preHandler:
  - Uses `createRemoteJWKSet` for Supabase JWKS (ES256, project ref `kzbwahfpwmtitnjqihkg`)
  - Verifies signature, issuer (`https://<ref>.supabase.co/auth/v1`), audience (`authenticated`), expiry
  - Attaches `request.userId`, `request.userEmail`, `request.userRole`
  - 401 on missing/malformed/invalid/expired tokens with generic `{error:'unauthorized'}` body; real cause logged via `request.log.warn`
  - Module-load env check throws if `SUPABASE_JWKS_URL` / `SUPABASE_JWT_ISSUER` missing (fail loud, fail early)
- Added `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER` to `.env`
- Created `.env.example` with sanitized placeholders
- Wired `env_file: - .env` into `docker-compose.yml` server service (indentation gotcha: YAML 4-space alignment)
- Added temp `GET /whoami` route (kept — useful standard endpoint; may rename to `/me` for prod)
- Three-case test passed: no token → 401, garbage → 401, valid Supabase JWT → 200 with correct userId + email

**Blockers / Issues (resolved):**
- Initial `cat > ... EOF` heredoc got pasted literally into `auth.js` → `ReferenceError: cat is not defined`. Rewrote via heredoc correctly.
- `jose` was installed on host but missing in container → had to rebuild image (`docker compose build server`) so `npm install` ran against updated `package.json`.
- Env vars not reaching container: `docker-compose.yml` `server` service had `environment:` but no `env_file:`. Added `env_file: - .env`.
- Once-off YAML indentation error on `env_file:` (5 spaces vs 4).

**Notes:**
- Supabase project is on asymmetric keys (ES256) — JWKS endpoint returns populated `keys` array. No HS256 fallback needed.
- `jose`'s `createRemoteJWKSet` handles caching + background refresh on unknown `kid`; no manual cache logic needed.
- npm audit warns about `drizzle-kit` → `@esbuild-kit/*` → old `esbuild` (dev-server CVE). Not exploitable here (drizzle-kit is dev-only, doesn't run esbuild's dev server). Leaving as-is.

**Next session I'll:**
- Phase 2.2: `GET /conversations` with cursor pagination, `last_message_preview`, `unread_count`
- Phase 2.3: `GET /conversations/:id/messages` with `?afterSequence=N` for reconnect replay
- Phase 2.4: `GET /unread-counts` with 30s Redis cache

---

### Session 2 — 2026-04-17 (evening)

**Duration:** ~2 hours
**Phase:** 1 — Data Model & Migrations (complete)

**Completed:**
- Installed Drizzle ORM + drizzle-kit, configured `drizzle.config.js`
- Wrote `server/db/schema.js` — 5 tables: conversations, messages, message_reads, message_reactions, blocked_users
- Key design decisions:
  - CHECK constraint `user_a_id < user_b_id` on conversations enforces pair normalization at DB level (also implicitly prevents self-conversations)
  - CHECK constraint on blocked_users prevents self-blocks
  - `next_sequence_number` column on conversations for atomic per-conversation sequence allocation (UPDATE...RETURNING pattern)
  - UNIQUE (conversation_id, client_nonce) on messages for idempotency
  - UNIQUE (conversation_id, sequence_number) for ordering
  - `message_type` as real Postgres enum
  - No FK on `reply_to_id` (handle "message not found" at read time instead of CASCADE/SET NULL)
  - No FKs on user UUIDs (they live in Supabase)
- Generated + applied migration `0000_material_landau.sql`
- Wrote `server/db/seed.js` — 2 conversations, 20 messages, 15 reads, 2 reactions
- Exercised the allocator pattern: Alice↔Bob `next_sequence_number = 17`, Alice↔Carol = 5 (correct)
- Verified full rebuild: `docker compose down -v` → `up` → `db:migrate` → `db:seed` produces identical state
- Added npm scripts: `db:generate`, `db:migrate`, `db:studio`, `db:drop`, `db:seed`

**Notes:**
- `.env` stays at repo root (`~/blingl-chat/.env`), shared with docker-compose. Drizzle-kit scripts use `node --env-file=../.env` to pick it up.
- Skipped PDF's `drizzle-kit drop` rollback test — drizzle doesn't generate down-migrations by default. The full-rebuild test is the more useful equivalent.
- Test UUIDs are visually distinguishable on purpose (1111..., 2222..., 3333...) so you can eyeball rows and know which user is which.

---

### Session 1 — 2026-04-17

**Duration:** ~1.5 hours
**Phase:** 0 — Environment & Tools

**Completed:**
- Created `~/blingl-chat/` project folder with full file skeleton
- Wrote `docker-compose.yml` with Postgres 16 + Redis 7 + Node 22
- Wrote minimal Fastify server (`server/index.js`) with:
  - `GET /` → friendly JSON
  - `GET /health` → checks Postgres + Redis
  - `GET /ws` → echo WebSocket
- `docker compose up --build` starts all three containers with healthy status
- `curl http://localhost:3000/health` returns `{"status":"ok","checks":{"postgres":"ok","redis":"ok"}}`
- Echo WebSocket verified via `websocat` (send/receive works)
- TablePlus installed, connected to empty `blingl_chat` database
- Git repo initialized, first commit made, pushed to `github.com/MyAppFuture/blingl-chat`

**Blockers / Issues:**
- SSH push to GitHub initially failed (no SSH key); switched remote to HTTPS which worked (Keychain had cached creds)

**Notes:**
- Server auto-reloads via `node --watch`
- Postgres data persists in Docker volume `postgres_data`
- Env vars in `.env` (not committed; confirmed via `git status` before first commit)
- Using ESM (`"type": "module"` in package.json)
- `pino-pretty` added for readable log output in dev