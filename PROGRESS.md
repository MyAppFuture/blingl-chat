# Blingl Chat — Progress Log

Track where you are between sessions. Update this file at the end of every work session.

## Current Status

**Current Phase:** 2 — REST API, Read Operations
**Current Step:** 2.2 — List conversations (GET /conversations)
**Last session date:** 2026-04-17
**Next action:** Implement GET /conversations sorted by last_message_at DESC, with cursor pagination and unread_count

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