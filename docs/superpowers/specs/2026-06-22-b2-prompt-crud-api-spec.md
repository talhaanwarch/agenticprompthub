# Backend Part 2 — Prompt CRUD API

- **Date:** 2026-06-22
- **Status:** Draft
- **Phase:** 1 — Prompt Management
- **Depends on:** B1 (auth middleware, session store, API key auth, `requireAuth`, `requireRole`)
- **Blocks:** B3 (versioning + aliases need the `prompts` table and IDs to exist)

---

## Overview

This part introduces the `prompts` table and all CRUD operations for the prompt resource. A prompt is a **named, mutable shell** — it carries a name and description, but no content. All content lives in `prompt_versions` (Part 3). This separation means a prompt can be renamed or deleted without touching its version history.

This part also introduces the `audit_log` table and the shared `audit()` helper. Parts 3–6 write to this table; Part 5 adds the read endpoint. Creating the table here ensures every subsequent part can emit audit events from day one.

**Definition of done:** A prompt can be created, listed by team, fetched by ID, renamed/re-described, and soft-deleted via the API. A Viewer cannot mutate prompts. Audit log records `prompt_created`, `prompt_renamed`, and `prompt_deleted` events.

---

## Database Schema

### `prompts`

```sql
CREATE TABLE prompts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  description TEXT,
  team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by  UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_prompts_team_id           ON prompts (team_id);
CREATE INDEX idx_prompts_team_name         ON prompts (team_id, name);
CREATE INDEX idx_prompts_team_deleted_at   ON prompts (team_id, deleted_at);
```

**Key decisions:**

- `name` is **mutable**. Renaming a prompt is a breaking change for any SDK caller using `renderPrompt(name, alias, vars)` — this is intentional and documented. The SDK caller is responsible for updating their call sites after a rename.
- No `UNIQUE(team_id, name)` constraint. Name collisions within a team are the user's responsibility; enforcing uniqueness would complicate rename + recreation workflows.
- `deleted_at IS NULL` means active; setting `deleted_at = now()` is the only delete in Phase 1. No rows are hard-deleted.
- `team_id` on every row; all queries include `WHERE team_id = $currentTeamId`. No RLS in Phase 1 — application-layer filtering enforces isolation.

### `audit_log`

```sql
CREATE TABLE audit_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  prompt_id  UUID        REFERENCES prompts(id) ON DELETE SET NULL,
  actor_id   UUID        NOT NULL REFERENCES users(id),
  event      TEXT        NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_team_prompt ON audit_log (team_id, prompt_id, created_at DESC);
CREATE INDEX idx_audit_log_team        ON audit_log (team_id, created_at DESC);
```

`prompt_id` is nullable — team-level events (API key generated/revoked, member role changed) have no associated prompt. `metadata` is a JSONB blob for event-specific data (e.g. `{ "old_name": "foo", "new_name": "bar" }` for a rename).

**Valid event constants** (all parts combined — defined as an enum/const in shared code):

```
prompt_created
prompt_renamed
prompt_deleted
version_committed
alias_promoted
alias_rolled_back
api_key_generated
api_key_revoked
member_invited
member_role_changed
member_removed
```

Parts 3–6 add their own events; the enum is extended as each part ships.

### Shared `audit()` helper

```ts
// src/lib/audit.ts
export async function audit(
  db: DbClient,
  params: {
    teamId: string;
    actorId: string;
    event: AuditEvent;
    promptId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void>
```

Called inside the same database transaction as the mutation it records. Never throws — if the audit insert fails, log the error and let the mutation succeed (audit loss is preferable to blocking user writes).

---

## Authorization

All prompt endpoints require authentication. The `requireAuth` middleware from B1 populates `req.user` (user object) and `req.teamId` (the user's active team ID) on every request.

**Role-based access:**

| Operation | Owner | Admin | Editor | Viewer |
|-----------|-------|-------|--------|--------|
| List / Get prompts | ✓ | ✓ | ✓ | ✓ |
| Create prompt | ✓ | ✓ | ✓ | ✗ |
| Update prompt (name/desc) | ✓ | ✓ | ✓ | ✗ |
| Delete prompt | ✓ | ✓ | ✓ | ✗ |

The `requireRole(...roles)` middleware from B1 enforces this. Viewer attempts to mutate return `403 FORBIDDEN`.

All queries include `AND team_id = $1` (bound to `req.teamId`). A prompt belonging to a different team is invisible — it returns 404, not 403, to avoid leaking existence.

Soft-deleted prompts (`deleted_at IS NOT NULL`) are excluded from all list and get responses and return 404 if fetched by ID.

---

## API Endpoints

### Error envelope (inherited from B1)

All error responses use:
```json
{
  "error": {
    "code": "SNAKE_CASE_CONSTANT",
    "message": "Human-readable description"
  }
}
```

---

### `POST /prompts` — Create a prompt

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')`

**Request body:**
```json
{
  "name": "string (required, 1–255 chars)",
  "description": "string (optional)"
}
```

**Validation:**
- `name`: required, non-empty after trim, max 255 characters → `400 VALIDATION_ERROR` if violated
- `description`: optional, max 2000 characters if provided → `400 VALIDATION_ERROR` if violated

**Success — `201 Created`:**
```json
{
  "id": "uuid",
  "name": "my-prompt",
  "description": "What this prompt does",
  "teamId": "uuid",
  "createdBy": "uuid",
  "createdAt": "2026-06-22T10:00:00Z"
}
```

**Error responses:**
- `400 VALIDATION_ERROR` — name missing/empty/too long or description too long
- `401 UNAUTHORIZED` — no valid session or API key
- `403 FORBIDDEN` — role is Viewer

**Audit:** emits `prompt_created` with `metadata: { name }`.

---

### `GET /prompts` — List prompts for team

**Auth:** `requireAuth` (any role)

**Query parameters:**

| Param | Type | Default | Constraint |
|-------|------|---------|------------|
| `search` | string | — | ILIKE match on name and description |
| `page` | integer | 1 | min 1 |
| `limit` | integer | 20 | min 1, max 100 |

**Behaviour:**
- Returns only active prompts (`deleted_at IS NULL`) scoped to `req.teamId`
- If `search` is provided: `name ILIKE '%{search}%' OR description ILIKE '%{search}%'`
- Ordered by `created_at DESC`
- Pagination is offset-based: `OFFSET (page - 1) * limit LIMIT limit`

**Success — `200 OK`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "my-prompt",
      "description": "What this prompt does",
      "createdAt": "2026-06-22T10:00:00Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

`total` is the count of matching rows (for pagination controls), not the count in `data`.

**Error responses:**
- `401 UNAUTHORIZED`

---

### `GET /prompts/:id` — Get a single prompt

**Auth:** `requireAuth` (any role)

**Path param:** `id` — UUID of the prompt

**Success — `200 OK`:**
```json
{
  "id": "uuid",
  "name": "my-prompt",
  "description": "What this prompt does",
  "teamId": "uuid",
  "createdBy": "uuid",
  "createdAt": "2026-06-22T10:00:00Z"
}
```

**Error responses:**
- `401 UNAUTHORIZED`
- `404 NOT_FOUND` — prompt does not exist, belongs to a different team, or has been soft-deleted

---

### `PATCH /prompts/:id` — Update name and/or description

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')`

**Request body** (at least one field required):
```json
{
  "name": "new-name (optional)",
  "description": "new description (optional)"
}
```

**Validation:**
- At least one of `name` or `description` must be present → `400 VALIDATION_ERROR` if both absent
- `name`: non-empty after trim, max 255 chars → `400 VALIDATION_ERROR` if violated
- `description`: max 2000 chars; pass `null` to clear it

**Behaviour:**
- Partial update — only fields present in the body are modified
- Returns the full updated prompt object

**Success — `200 OK`:** full prompt object (same shape as `GET /prompts/:id`)

**Error responses:**
- `400 VALIDATION_ERROR` — no fields provided, name empty/too long, description too long
- `401 UNAUTHORIZED`
- `403 FORBIDDEN` — Viewer role
- `404 NOT_FOUND`

**Audit:**
- If `name` changed: emits `prompt_renamed` with `metadata: { old_name, new_name }`
- If only `description` changed: emits `prompt_updated` with `metadata: { field: "description" }`

---

### `DELETE /prompts/:id` — Soft-delete a prompt

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')`

**Behaviour:**
- Sets `deleted_at = now()` on the prompt row
- Does not touch `prompt_versions` or `prompt_aliases` rows — version history is preserved in the database even after deletion (Part 5 export can still access them if needed in a future phase)
- Subsequent `GET /prompts/:id` returns 404
- Prompt disappears from `GET /prompts` list

**Success — `204 No Content`:** empty body

**Error responses:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN` — Viewer role
- `404 NOT_FOUND` — already deleted, wrong team, or never existed

**Audit:** emits `prompt_deleted` with `metadata: { name }`.

---

## Error Handling

| Scenario | HTTP | Code |
|----------|------|------|
| Missing/invalid auth credential | 401 | `UNAUTHORIZED` |
| Insufficient role | 403 | `FORBIDDEN` |
| Prompt not found / wrong team / deleted | 404 | `NOT_FOUND` |
| Validation failure | 400 | `VALIDATION_ERROR` |
| Unexpected server error | 500 | `INTERNAL_ERROR` |

- Soft-deleted prompts always return 404, not 410. The deletion state is an implementation detail not exposed to callers.
- A prompt from a different team also returns 404 (not 403) — existence is not leaked.
- 500 responses log the full error server-side but return only `{ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }` to the client.

---

## Testing

All tests use a real Postgres test database (no mocks). Each test resets relevant tables before running.

**Prompt creation:**
- `POST /prompts` with valid body → 201, response matches schema, row in DB
- `POST /prompts` without `name` → 400 VALIDATION_ERROR
- `POST /prompts` with `name` as empty string → 400 VALIDATION_ERROR
- `POST /prompts` with `name` of 256 chars → 400 VALIDATION_ERROR
- `POST /prompts` as Viewer → 403 FORBIDDEN

**Listing:**
- `GET /prompts` returns only prompts for current team (seed two teams, assert no bleed)
- `GET /prompts?search=foo` returns prompts matching name or description (case-insensitive), excludes non-matches
- `GET /prompts?page=2&limit=5` returns correct slice and correct `total`
- Soft-deleted prompts are excluded from list

**Fetch by ID:**
- `GET /prompts/:id` → 200 with correct shape
- `GET /prompts/:id` with ID from different team → 404
- `GET /prompts/:id` after soft-delete → 404

**Update:**
- `PATCH /prompts/:id` with `name` only → updates name, description unchanged
- `PATCH /prompts/:id` with `description` only → updates description, name unchanged
- `PATCH /prompts/:id` with no body fields → 400 VALIDATION_ERROR
- `PATCH /prompts/:id` as Viewer → 403 FORBIDDEN

**Delete:**
- `DELETE /prompts/:id` → 204, row in DB has `deleted_at` set
- `DELETE /prompts/:id` again → 404 (already deleted)
- `DELETE /prompts/:id` as Viewer → 403 FORBIDDEN

**Audit log:**
- Create prompt → `audit_log` has `prompt_created` entry with correct `team_id`, `actor_id`, `prompt_id`
- Rename prompt → `audit_log` has `prompt_renamed` entry with `metadata.old_name` and `metadata.new_name`
- Delete prompt → `audit_log` has `prompt_deleted` entry

---

## Definition of Done

- [ ] `prompts` and `audit_log` tables created with correct schema and indexes
- [ ] `audit()` helper implemented and tested in isolation
- [ ] All 5 endpoints implemented and returning correct shapes
- [ ] Viewer role blocked from all mutation endpoints (403)
- [ ] Cross-team isolation confirmed by test (no prompt bleeds across teams)
- [ ] Soft-delete confirmed: row persists in DB, GET/list returns 404/excludes
- [ ] All audit events emitted for create, rename, delete
- [ ] All tests pass against a real Postgres instance
- [ ] No `name` uniqueness constraint (confirm by creating two prompts with the same name in same team — both succeed)
