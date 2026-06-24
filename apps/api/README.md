# `@agenticprompthub/api`

Express/TypeScript REST API — Phase 1 (Schema, Auth & API Keys).

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20+ |
| npm | 10+ (workspaces) |
| Docker | any recent |

A PostgreSQL container must be running before you start. If you use the project's Docker setup:

```bash
docker run -d \
  --name postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:18-alpine
```

---

## First-time setup

### 1. Install dependencies (from monorepo root)

```bash
npm install
```

### 2. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
```

The defaults in `.env.example` work out of the box with the Docker container above:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentichub
SESSION_SECRET=replace-with-output-of--openssl-rand-hex-32
NODE_ENV=development
PORT=3000
```

> Phase 1 uses a **single database** — there is no separate test database.

Generate a proper `SESSION_SECRET` for any non-dev environment:

```bash
openssl rand -hex 32
```

### 3. Create the database and run migrations

One command does everything — creates the `agentichub` database if it doesn't exist and applies all Prisma migrations (including the `session` table):

```bash
npm run db:setup -w @agenticprompthub/api
```

By default it connects to `postgres://postgres:postgres@localhost:5432/postgres` to create the database. If your root connection string is different, override it:

```bash
PG_ROOT_URL=postgres://myuser:mypass@localhost:5432/postgres npm run db:setup -w @agenticprompthub/api
```

---

## Running the server

```bash
# development (watch mode, auto-restarts on file change)
cd apps/api
npm run dev

# or from the monorepo root (Turborepo)
npm run dev
```

Server starts at **http://localhost:3000** (override with `PORT=` in `.env`).

---

## Running tests

The integration-test philosophy (real HTTP → service → repository → real Postgres,
no mocks) is unchanged, but the test **database** is not provisioned during the
Phase 1 build — `db:setup` creates a single `agentichub` database only.

> **`npm test` currently errors.** `client.ts`/`app.ts` require `TEST_DATABASE_URL`
> when `NODE_ENV=test`, and that variable + the `agentichub_test` database were
> removed. Re-wiring a dedicated test database is a deliberate follow-up.

---

## Database migrations

Migrations are managed by **Prisma Migrate**. The schema lives in
`prisma/schema.prisma`; migrations are generated into `prisma/migrations/`.

```bash
cd apps/api

# Create + apply a new migration after editing prisma/schema.prisma
npm run db:migrate          # prisma migrate dev

# Regenerate the Prisma Client (after a schema change)
npm run db:generate         # prisma generate

# Apply already-generated migrations (CI / fresh clone)
npx prisma migrate deploy
```

Never edit a generated `migration.sql` by hand — create a new migration instead.

---

## API Reference

All endpoints are prefixed with `/api/v1`.

Authentication uses **session cookies** (browser) or **`Authorization: Bearer <key>`** (SDK / programmatic). Both are accepted on every protected endpoint.

### Error shape

Every error response follows this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
    "message": "Human-readable description."
  }
}
```

---

### Auth

#### `POST /api/v1/auth/signup`

Creates a user, a personal team, adds the user as `owner`, and sets a session cookie.

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "password123"}'
```

**Request body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `email` | string | yes | Normalised to lowercase |
| `password` | string | yes | Minimum 8 characters |
| `displayName` | string | no | Used in audit logs and member lists |

**Response `201`**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "alice@example.com",
    "displayName": null
  },
  "team": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "alice@example.com's team"
  }
}
```

Sets a `connect.sid` HttpOnly session cookie valid for 7 days.

**Errors**

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | Missing/invalid fields |
| 409 | `CONFLICT` | Email already registered |

---

#### `POST /api/v1/auth/login`

Authenticates an existing user and sets a session cookie.

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "password123"}'
```

**Request body**

| Field | Type | Required |
|-------|------|----------|
| `email` | string | yes |
| `password` | string | yes |

**Response `200`** — same shape as signup.

**Errors**

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | Missing fields |
| 401 | `UNAUTHORIZED` | Wrong email or password (same message for both — no user enumeration) |

---

#### `POST /api/v1/auth/logout`

Destroys the current session. Requires an active session cookie.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/v1/auth/logout
```

**Response `204`** — no body.

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | No active session |

---

#### `GET /api/v1/auth/me`

Returns the authenticated user, their team, and their roles within that team.

```bash
curl -b cookies.txt http://localhost:3000/api/v1/auth/me
```

**Response `200`**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "alice@example.com",
    "displayName": null
  },
  "team": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "alice@example.com's team"
  },
  "roles": ["owner"]
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | No active session |

---

### API Keys

All API key endpoints accept **either** a session cookie or a `Bearer` token.

#### `POST /api/v1/api-keys`

Creates a new API key for the authenticated user's team. The full key value is returned **only in this response** — it cannot be retrieved again.

```bash
# with session cookie
curl -b cookies.txt -X POST http://localhost:3000/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-dev-key"}'

# with Bearer token
curl -X POST http://localhost:3000/api/v1/api-keys \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-dev-key"}'
```

**Request body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | no | Max 100 characters |

**Response `201`**

```json
{
  "id": "a3bb189e-8bf9-3888-9912-ace4e6543002",
  "key": "a1b2c3d4e5f6...64hexchars",
  "name": "my-dev-key",
  "createdAt": "2026-06-23T10:00:00.000Z"
}
```

`key` is 64 hex characters (32 random bytes). Store it securely — this is the only time it is shown.

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |

---

#### `GET /api/v1/api-keys`

Lists all active (non-revoked) API keys for the authenticated user's team. The full key value is never returned — only the last four characters.

```bash
curl -b cookies.txt http://localhost:3000/api/v1/api-keys
```

**Response `200`**

```json
[
  {
    "id": "a3bb189e-8bf9-3888-9912-ace4e6543002",
    "name": "my-dev-key",
    "lastFour": "3002",
    "createdAt": "2026-06-23T10:00:00.000Z"
  }
]
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |

---

#### `DELETE /api/v1/api-keys/:id`

Soft-revokes an API key (sets `revoked_at`). The key immediately stops authenticating requests. You can only revoke keys belonging to your own team.

```bash
curl -b cookies.txt -X DELETE \
  http://localhost:3000/api/v1/api-keys/a3bb189e-8bf9-3888-9912-ace4e6543002
```

**Response `204`** — no body.

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |
| 404 | `NOT_FOUND` | Key doesn't exist or belongs to a different team |

---

## Project structure

```
apps/api/
├── src/
│   ├── auth/                  # signup, login, logout, me
│   ├── api-keys/              # create, list, revoke
│   └── shared/
│       ├── db/
│       │   ├── client.ts      # single PrismaClient instance
│       │   └── schema.ts      # re-exported Prisma model types
│       ├── middleware/
│       │   ├── error.middleware.ts
│       │   ├── require-auth.middleware.ts
│       │   └── require-api-key.middleware.ts
│       └── errors/            # typed HTTP error classes
├── prisma/
│   ├── schema.prisma          # single source of truth for all models
│   └── migrations/            # Prisma Migrate generated SQL
├── scripts/
│   └── db-setup.ts            # first-time DB bootstrap (npm run db:setup)
├── app.ts                     # Express factory (no listen)
└── server.ts                  # entry point (calls listen)
```

## Database schema (Phase 1)

| Table | Purpose |
|-------|---------|
| `users` | One row per registered user |
| `teams` | Tenancy unit — every user gets a personal team on signup |
| `team_members` | Many-to-many join between users and teams |
| `team_member_roles` | Roles held by a team member (`owner`, `admin`, `editor`, `viewer`) |
| `api_keys` | Long-lived Bearer tokens scoped to a user + team |
| `session` | express-session persistence — defined in the Prisma schema (so migrations create it), read/written at runtime by connect-pg-simple |
