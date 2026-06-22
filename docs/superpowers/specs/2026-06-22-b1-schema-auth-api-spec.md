# Backend Part 1 — Schema + Auth API

- **Date:** 2026-06-22
- **Status:** Draft
- **Phase:** 1 — Prompt Management
- **Depends on:** Nothing (foundation)
- **Blocks:** All other backend parts

---

## Overview

This part establishes the entire Postgres schema for Phase 1 and the auth layer that all subsequent parts depend on. It ships before anything else because every table, every middleware guard, and every API key check is built on top of what is defined here.

By the end of this part:
- The database schema is fully migrated (all tables that Parts 2–6 will write to exist)
- A developer can sign up, log in, and authenticate via session cookie or API key
- The personal team is auto-created on signup so Parts 2–6 never have to handle a "no team" state

**Not in scope:** prompt tables, versioning, SDK, diff, or team invite flows — those come in later parts.

---

## Database Schema

All tables use `gen_random_uuid()` for primary keys. Run with `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` (or `"uuid-ossp"`) if not already enabled.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Core identity
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users (email);

-- Tenancy unit (no "type" column — every team is just a team)
CREATE TABLE teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: users ↔ teams
CREATE TABLE team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, team_id)
);
CREATE INDEX idx_team_members_team_id ON team_members (team_id);
CREATE INDEX idx_team_members_user_id ON team_members (user_id);

-- Roles per membership (join table — one row per role, supports multi-role)
CREATE TYPE team_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
CREATE TABLE team_member_roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  role           team_role NOT NULL,
  UNIQUE (team_member_id, role)
);
CREATE INDEX idx_team_member_roles_member_id ON team_member_roles (team_member_id);

-- Personal and team-scoped API keys (plain text — upgraded before real users)
CREATE TABLE api_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_api_keys_key ON api_keys (key) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_user_team ON api_keys (user_id, team_id);

-- Session store (connect-pg-simple creates this automatically via its own migration,
-- but document the expected shape here for reference)
-- Table: sessions (sid VARCHAR PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMPTZ NOT NULL)
-- connect-pg-simple handles CREATE TABLE with: pgSession.sync({ force: false })
```

> **Audit log table** (`audit_log`) is defined in Backend Part 5 (Diff + Audit). Parts 1–4 must write audit events; the table just lives in Part 5's migration. Parts 1–4 write events via a `recordAuditEvent()` helper that is a no-op until the table exists — integration tests for Parts 1–4 skip audit assertions; Part 5 tests verify the backfill.

---

## Middleware

### `requireAuth`

```ts
// Checks session. Attaches req.user and req.teamId. Returns 401 if unauthenticated.
async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
  }
  const user = await db.query('SELECT id, email FROM users WHERE id = $1', [req.session.userId]);
  if (!user.rows[0]) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session invalid.' } });
  }
  req.user = user.rows[0];
  req.teamId = req.session.teamId;
  next();
}
```

### `requireApiKey`

Used by the SDK and any caller passing `Authorization: Bearer <key>`. Session auth takes priority — if a valid session exists, this middleware is not reached.

```ts
async function requireApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'API key required.' } });
  }
  const key = authHeader.slice(7);
  const result = await db.query(
    `SELECT ak.id, ak.user_id, ak.team_id, u.email
     FROM api_keys ak JOIN users u ON u.id = ak.user_id
     WHERE ak.key = $1 AND ak.revoked_at IS NULL`,
    [key]
  );
  if (!result.rows[0]) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked API key.' } });
  }
  const row = result.rows[0];
  req.user = { id: row.user_id, email: row.email };
  req.teamId = row.team_id;
  next();
}
```

### `requireRole(...roles)`

Applied after `requireAuth`. Fetches the roles for the current user in the current team and checks for membership in the required set.

```ts
function requireRole(...allowedRoles: string[]) {
  return async (req, res, next) => {
    const result = await db.query(
      `SELECT tmr.role
       FROM team_member_roles tmr
       JOIN team_members tm ON tm.id = tmr.team_member_id
       WHERE tm.user_id = $1 AND tm.team_id = $2`,
      [req.user.id, req.teamId]
    );
    const userRoles = result.rows.map(r => r.role);
    const hasRole = allowedRoles.some(r => userRoles.includes(r));
    if (!hasRole) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient role.' } });
    }
    req.userRoles = userRoles;
    next();
  };
}
```

### Session Configuration

```ts
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

const PgStore = connectPgSimple(session);

app.use(session({
  store: new PgStore({ conString: process.env.DATABASE_URL }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days rolling
    sameSite: 'lax',
  },
}));
```

---

## API Endpoints

### POST /auth/signup

**Auth:** None

**Body:**
```json
{ "email": "user@example.com", "password": "minimum8chars" }
```

**Validation:**
- `email` required, must be valid email format
- `password` required, minimum 8 characters

**Logic:**
1. Check for existing user with that email — 409 if found
2. `bcrypt.hash(password, 12)`
3. Insert `users` row
4. Insert `teams` row with `name = "<email>'s team"`
5. Insert `team_members` row linking user ↔ team
6. Insert `team_member_roles` row with `role = 'owner'`
7. Set `req.session.userId = user.id`, `req.session.teamId = team.id`
8. Return 201

**Success (201):**
```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "team": { "id": "uuid", "name": "user@example.com's team" }
}
```

**Errors:**
- `400 VALIDATION_ERROR` — missing/invalid email or password too short
- `409 CONFLICT` — email already registered

---

### POST /auth/login

**Auth:** None

**Body:**
```json
{ "email": "user@example.com", "password": "mypassword" }
```

**Logic:**
1. Look up user by email — generic 401 if not found (do not distinguish "no user" from "wrong password")
2. `bcrypt.compare(password, user.password_hash)` — 401 if false
3. Look up the user's team (first team_member row, ordered by `created_at ASC` — personal team is always first)
4. Set `req.session.userId`, `req.session.teamId`
5. Return 200

**Success (200):**
```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "team": { "id": "uuid", "name": "user@example.com's team" }
}
```

**Errors:**
- `400 VALIDATION_ERROR` — missing email or password
- `401 UNAUTHORIZED` — invalid credentials (same message regardless of which failed)

---

### POST /auth/logout

**Auth:** `requireAuth`

**Logic:** `req.session.destroy()`

**Success (204):** No body

**Errors:**
- `401 UNAUTHORIZED` — not authenticated

---

### GET /auth/me

**Auth:** `requireAuth`

**Logic:**
1. Fetch user from DB (already attached by `requireAuth`)
2. Fetch team name
3. Fetch user's roles in the current team

**Success (200):**
```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "team": { "id": "uuid", "name": "user@example.com's team" },
  "roles": ["owner"]
}
```

**Errors:**
- `401 UNAUTHORIZED` — not authenticated

---

### POST /api-keys

**Auth:** `requireAuth`

**Body:**
```json
{ "name": "My local dev key" }
```
`name` is optional.

**Logic:**
1. `crypto.randomBytes(32).toString('hex')` — 64-character hex key
2. Insert into `api_keys` with `user_id`, `team_id`, `key`, `name`
3. Write audit event: `api_key_generated` (see Part 5 for audit schema; this call is a no-op until the table exists)
4. Return 201 — **this is the only time the full key is returned**

**Success (201):**
```json
{
  "id": "uuid",
  "key": "a3f9...64hex...chars",
  "name": "My local dev key",
  "createdAt": "2026-06-22T00:00:00Z"
}
```

**Errors:**
- `401 UNAUTHORIZED` — not authenticated

---

### GET /api-keys

**Auth:** `requireAuth`

**Logic:** Select all non-revoked keys for `user_id + team_id`. Return last 4 chars of key only.

**Success (200):**
```json
[
  {
    "id": "uuid",
    "name": "My local dev key",
    "lastFour": "3f9a",
    "createdAt": "2026-06-22T00:00:00Z"
  }
]
```

Empty array if no keys.

**Errors:**
- `401 UNAUTHORIZED` — not authenticated

---

### DELETE /api-keys/:id

**Auth:** `requireAuth`

**Logic:**
1. Find key by `id` WHERE `user_id = req.user.id` AND `team_id = req.teamId` AND `revoked_at IS NULL`
2. 404 if not found
3. `UPDATE api_keys SET revoked_at = now() WHERE id = $1`
4. Write audit event: `api_key_revoked`
5. Return 204

**Success (204):** No body

**Errors:**
- `401 UNAUTHORIZED` — not authenticated
- `404 NOT_FOUND` — key not found or not owned by current user

---

## Error Handling

All error responses follow this envelope:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable message." } }
```

| HTTP Status | Code | When |
|-------------|------|------|
| 400 | `VALIDATION_ERROR` | Missing/invalid request body fields |
| 401 | `UNAUTHORIZED` | Not authenticated, invalid session, bad API key |
| 403 | `FORBIDDEN` | Authenticated but insufficient role |
| 404 | `NOT_FOUND` | Resource not found or not accessible |
| 409 | `CONFLICT` | Duplicate email on signup |
| 500 | `INTERNAL_ERROR` | Unhandled server errors |

500s **must** log the full error (stack trace) to server-side logs but **must not** include error details in the response body. Generic message only: `"An unexpected error occurred."`.

A global Express error handler wraps all routes:

```ts
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string, e.g. `postgres://user:pass@localhost:5432/agentichub` |
| `SESSION_SECRET` | Yes | Random string, minimum 32 characters. Generate with `openssl rand -hex 32`. |
| `NODE_ENV` | No | `development` (default) or `production`. Controls cookie `secure` flag. |

No other env vars are introduced in this part. Later parts will add `PORT` if not already present.

---

## Testing

Use **Jest + Supertest** with a real Postgres test database (no mocks). Each test suite runs against a fresh schema (truncate tables between tests, or use transactions rolled back after each test).

### Test cases

**Signup**
- POST /auth/signup with valid email + password → 201, response contains user.id, team.id
- POST /auth/signup with same email twice → 409
- POST /auth/signup with missing password → 400
- POST /auth/signup with password < 8 chars → 400
- POST /auth/signup: verify DB has user row, teams row, team_members row, team_member_roles row with role='owner'
- POST /auth/signup: verify session cookie is set in response

**Login**
- POST /auth/login with valid credentials → 200, session cookie set
- POST /auth/login with wrong password → 401
- POST /auth/login with unknown email → 401 (same message, no user enumeration)
- POST /auth/login with missing fields → 400

**Logout**
- POST /auth/logout after login → 204
- POST /auth/logout without session → 401

**Me**
- GET /auth/me after login → 200 with user, team, roles
- GET /auth/me without session → 401

**API Keys**
- POST /api-keys → 201 with full key in response
- GET /api-keys → 200, key not included (only lastFour)
- DELETE /api-keys/:id → 204, key is soft-deleted (revoked_at set)
- DELETE /api-keys/:id with wrong user → 404
- Revoked key rejected by requireApiKey middleware → 401

**requireApiKey middleware**
- Request with valid Bearer key → 200, req.user populated
- Request with revoked key → 401
- Request with malformed header → 401

**requireRole middleware**
- Owner accessing owner-only endpoint → 200
- Viewer accessing owner-only endpoint → 403

---

## Definition of Done

Signup, login, logout, and `/auth/me` all work via curl/Postman. A personal API key can be generated and then revoked. Authenticated requests via session cookie and via `Authorization: Bearer` header both succeed. All integration tests pass against a real Postgres instance.
