# Backend Part 6 — Teams + RBAC API

- **Date:** 2026-06-22
- **Status:** Draft
- **Phase:** 1 — Prompt Management
- **Depends on:** B1 (auth, `users`, `teams`, `team_members`, `team_member_roles`, `api_keys`), B5 (audit trail infra)
- **Blocks:** F4 (Team Management UI)

---

## Overview

Up to B5 the platform runs single-user: every user has a personal team auto-created on signup, and the only member is themselves. B6 is the inflection point from solo tool to collaborative platform: it lets a second (or third) person join that team via a shareable invite link, assigns them roles, and introduces team-scoped API keys that authorise SDK/API access without being tied to a specific user account.

There is no email service dependency. The inviter generates a link and shares it manually (Slack, email, etc.). AWS SES is earmarked for a later invite-by-email upgrade but is out of scope here.

**Definition of done:** Two test users in the same team — one Owner, one Viewer — demonstrate that the Viewer receives `403` when attempting to commit a version or promote an alias. An invite link is generated, accepted, and the new member appears in `GET /teams/:id/members` with correct roles.

---

## Database Schema

### New table: `team_invites`

```sql
CREATE TABLE team_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  invited_by  UUID        NOT NULL REFERENCES users(id),
  roles       TEXT[]      NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_invites_token   ON team_invites(token);
CREATE INDEX idx_team_invites_team_id ON team_invites(team_id);
```

- `token` is generated server-side as `crypto.randomBytes(32).toString('hex')` — 64 hex chars, 256 bits of entropy.
- `used_at` is `NULL` until accepted. A non-null `used_at` means the invite is consumed; acceptance is rejected.
- `roles` is a Postgres text array (e.g. `ARRAY['editor']`). All elements must be valid non-owner roles.

### Migration: add `admin` role to `team_member_roles`

B1 defines the CHECK constraint on `team_member_roles.role` as `IN ('owner', 'editor', 'viewer')`. This migration extends it to include `admin`:

```sql
ALTER TABLE team_member_roles
  DROP CONSTRAINT team_member_roles_role_check,
  ADD CONSTRAINT team_member_roles_role_check
    CHECK (role IN ('owner', 'admin', 'editor', 'viewer'));
```

### Migration: add `scope` column to `api_keys`

B1 stores personal API keys in `api_keys`. Team-scoped keys share the same table but have `user_id = NULL`. A `scope` discriminator column makes this explicit and queryable:

```sql
ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'team'));
```

After migration the column invariants are:
- Personal key: `scope = 'personal'`, `user_id = <uuid>`, `team_id = <uuid>`
- Team key: `scope = 'team'`, `user_id = NULL`, `team_id = <uuid>`

No data migration is needed — all existing rows are personal keys and default to `'personal'` correctly.

---

## Role Hierarchy and Permissions

Roles are stored in `team_member_roles` (one row per role per `team_member`). A user may hold multiple roles simultaneously; if any held role permits an action, the action is allowed.

| Action | Owner | Admin | Editor | Viewer |
|---|:---:|:---:|:---:|:---:|
| Read prompts / versions / aliases | ✓ | ✓ | ✓ | ✓ |
| Create prompt / edit name+description | ✓ | ✓ | ✓ | ✗ |
| Commit new version | ✓ | ✓ | ✓ | ✗ |
| Promote / roll back aliases | ✓ | ✓ | ✓ | ✗ |
| Generate / revoke API keys | ✓ | ✓ | ✗ | ✗ |
| Invite members | ✓ | ✓ | ✗ | ✗ |
| Manage member roles | ✓ | ✓ | ✗ | ✗ |
| Remove members | ✓ | ✓ | ✗ | ✗ |
| Delete team | ✓ | ✗ | ✗ | ✗ |
| Reassign ownership | ✓ | ✗ | ✗ | ✗ |

**Team-scoped API key** (no associated user): treated as editor-level — can read, render, commit versions, and promote aliases; cannot manage members, generate/revoke keys, or delete the team.

**`reviewer` role** is deferred — not included in this spec.

---

## Middleware

### `requireRole(...roles)`

Reusable Express middleware factory used by all team-management endpoints:

```
requireRole('owner', 'admin')
```

- Reads `req.session.userId` (set by `requireAuth`)
- Queries `team_member_roles` joined with `team_members` for the `team_id` from `req.params.id`
- If the user holds at least one of the specified roles → `next()`
- Otherwise → `403 FORBIDDEN`

### Updated `requireApiKey` middleware

The B1 middleware is updated to handle both personal and team keys:

```
1. SELECT * FROM api_keys WHERE key = $1 AND revoked_at IS NULL
2. If scope = 'personal': req.teamId = key.team_id, req.userId = key.user_id
3. If scope = 'team':     req.teamId = key.team_id, req.userId = null
4. Attach key scope to req so downstream permission checks can limit team-key access
```

Team key permission enforcement: endpoints that manage members, generate/revoke keys, or delete the team must check `req.userId !== null` in addition to role checks. If `req.userId` is null (team key), those endpoints return `403 TEAM_KEY_NOT_PERMITTED`.

---

## API Endpoints

All endpoints require session auth (`requireAuth`) unless noted. Team management endpoints additionally require `requireRole(...)` as specified per endpoint. All team IDs in path params refer to a team the authenticated user is a member of; a non-member gets `403`.

---

### POST /teams/:id/invites — generate invite link

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

**Request body:**
```json
{ "roles": ["editor"] }
```

**Validation:**
- `roles` is a non-empty array
- Every element ∈ `['admin', 'editor', 'viewer']` — `'owner'` is rejected (cannot invite someone as owner)
- Returns `400 VALIDATION_ERROR` if either check fails

**Logic:**
1. Generate token: `crypto.randomBytes(32).toString('hex')`
2. Insert into `team_invites` with `expires_at = now() + interval '7 days'`
3. Return invite

**Response 201:**
```json
{
  "id": "<uuid>",
  "token": "<hex>",
  "inviteUrl": "/invites/<hex>",
  "roles": ["editor"],
  "expiresAt": "2026-06-29T20:00:00Z"
}
```

`inviteUrl` is a relative path. The frontend constructs the full URL (`https://<host>/invites/<token>`). The backend never knows its own public hostname.

---

### GET /teams/:id/invites — list pending invites

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

Returns invites where `used_at IS NULL AND expires_at > now()`.

**Response 200:**
```json
[
  {
    "id": "<uuid>",
    "roles": ["editor"],
    "expiresAt": "2026-06-29T20:00:00Z",
    "createdAt": "2026-06-22T20:00:00Z",
    "invitedBy": { "id": "<uuid>", "email": "alice@example.com" }
  }
]
```

`token` is **not** returned — an admin listing invites should not be able to retroactively extract the shareable token.

---

### DELETE /teams/:id/invites/:inviteId — revoke pending invite

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

Hard-deletes the `team_invites` row. If the invite is already used or belongs to a different team, return `404`.

**Response:** `204 No Content`

---

### POST /teams/invites/:token/accept — accept invite

**Auth:** `requireAuth` (any authenticated user — no team membership required yet)

**Logic:**
1. `SELECT * FROM team_invites WHERE token = $1` → `404` if not found
2. `used_at IS NOT NULL` → `409 INVITE_ALREADY_USED`
3. `expires_at <= now()` → `410 INVITE_EXPIRED`
4. Check if `req.userId` already a member of `invite.team_id` → `409 ALREADY_A_MEMBER`
5. In a transaction:
   - `INSERT INTO team_members (team_id, user_id)` 
   - `INSERT INTO team_member_roles` for each role in `invite.roles`
   - `UPDATE team_invites SET used_at = now() WHERE id = $id`
6. Emit audit event `member_invited` with `{ newUserId: req.userId, roles: invite.roles }`

**Response 200:**
```json
{
  "team": { "id": "<uuid>", "name": "Alice's Team" },
  "roles": ["editor"]
}
```

---

### GET /teams/:id/members — list members with roles

**Auth:** `requireAuth` (any team member — viewer-level access)

Joins `team_members` + `team_member_roles` + `users`. Groups roles per user.

**Response 200:**
```json
[
  {
    "userId": "<uuid>",
    "email": "alice@example.com",
    "roles": ["owner"],
    "joinedAt": "2026-06-22T10:00:00Z"
  },
  {
    "userId": "<uuid>",
    "email": "bob@example.com",
    "roles": ["editor"],
    "joinedAt": "2026-06-22T20:00:00Z"
  }
]
```

---

### PATCH /teams/:id/members/:userId/roles — update member roles

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

**Request body:**
```json
{ "roles": ["admin", "editor"] }
```

**Validation:**
- `roles` is a non-empty array
- Every element ∈ `['admin', 'editor', 'viewer']` — cannot assign `'owner'` via this endpoint
- Returns `400 VALIDATION_ERROR` if either check fails

**Guards:**
- Target user has role `owner` → `403 CANNOT_MODIFY_OWNER`
- Actor is modifying their own roles and the new set would remove `admin` or `owner` → `403 SELF_LOCKOUT` (prevents accidental self-demotion)

**Logic:**
1. Load existing roles for `userId` in `team_id`
2. DELETE all existing `team_member_roles` for this `team_member`
3. INSERT new roles
4. Emit audit event `member_role_updated` with `{ targetUserId, oldRoles, newRoles }`

**Response 200:**
```json
{ "userId": "<uuid>", "roles": ["admin", "editor"] }
```

---

### DELETE /teams/:id/members/:userId — remove member

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

**Guards:**
- Target user has role `owner` → `403 CANNOT_REMOVE_OWNER`
- `userId === req.session.userId` (removing self) → `403 CANNOT_REMOVE_SELF`

**Logic:**
1. DELETE `team_member_roles` for this `team_member`
2. DELETE `team_members` row
3. Emit audit event `member_removed` with `{ removedUserId: userId }`

**Response:** `204 No Content`

---

### POST /teams/:id/api-keys — generate team-scoped API key

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

**Request body (optional):**
```json
{ "name": "CI/CD key" }
```

**Logic:**
1. Generate key: `'th_' + crypto.randomBytes(24).toString('hex')` (same prefix pattern as personal keys)
2. INSERT into `api_keys` with `scope = 'team'`, `team_id = :id`, `user_id = NULL`
3. Emit audit event `api_key_generated` with `{ scope: 'team', name }`

**Response 201:**
```json
{
  "id": "<uuid>",
  "key": "th_<hex>",
  "name": "CI/CD key",
  "scope": "team",
  "createdAt": "2026-06-22T20:00:00Z"
}
```

`key` is returned once. It is stored plain text in this phase (no real external users yet; hash-on-store is earmarked before public launch).

---

### DELETE /teams/:id/api-keys/:keyId — revoke team-scoped key

**Auth:** `requireAuth` + `requireRole('owner', 'admin')`

**Guard:** key must exist, belong to `team_id = :id`, and have `scope = 'team'`. Returns `404` otherwise (prevents cross-team key revocation).

**Logic:**
1. `UPDATE api_keys SET revoked_at = now() WHERE id = :keyId AND team_id = :id AND scope = 'team' AND revoked_at IS NULL`
2. Emit audit event `api_key_revoked` with `{ scope: 'team' }`

**Response:** `204 No Content`

---

## Audit Events

All audit writes use the `audit_log` infrastructure from B5.

| Event | `entity_type` | `entity_id` | `metadata` |
|---|---|---|---|
| `member_invited` | `team` | team_id | `{ newUserId, roles }` |
| `member_role_updated` | `team` | team_id | `{ targetUserId, oldRoles, newRoles }` |
| `member_removed` | `team` | team_id | `{ removedUserId }` |
| `api_key_generated` | `api_key` | key_id | `{ scope: 'team', name }` |
| `api_key_revoked` | `api_key` | key_id | `{ scope: 'team' }` |

`actor_id` is `req.session.userId` for session-auth requests, `NULL` for team-key-auth requests (audit events on team-key actions will have `actor_id = NULL`).

---

## Error Catalogue

| Code | HTTP | Meaning |
|---|---|---|
| `INVITE_ALREADY_USED` | 409 | Invite token already consumed |
| `INVITE_EXPIRED` | 410 | Invite token past 7-day expiry |
| `ALREADY_A_MEMBER` | 409 | Accepting user is already in this team |
| `CANNOT_MODIFY_OWNER` | 403 | Target user holds the owner role |
| `CANNOT_REMOVE_OWNER` | 403 | Cannot remove the team owner |
| `CANNOT_REMOVE_SELF` | 403 | Actor cannot remove themselves |
| `SELF_LOCKOUT` | 403 | Role update would strip actor of admin access |
| `TEAM_KEY_NOT_PERMITTED` | 403 | Team API key cannot perform member management |
| `UNAUTHORIZED` | 401 | No active session or valid API key |
| `FORBIDDEN` | 403 | Insufficient role for this action |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Request body failed validation |

---

## Testing

**Invite flow:**
- `POST /teams/:id/invites` with valid roles → 201, response includes token and expiresAt ~7 days out
- Accept the returned token as a different authenticated user → 200, new member appears in `GET /teams/:id/members`
- Accept the same token a second time → 409 `INVITE_ALREADY_USED`
- Mutate a valid invite's `expires_at` to the past, then accept → 410 `INVITE_EXPIRED`
- Attempt to invite with `roles: ['owner']` → 400 `VALIDATION_ERROR`
- Accept invite as a user already in the team → 409 `ALREADY_A_MEMBER`

**Role enforcement (cross-part):**
- Viewer user attempts `POST /prompts/:id/versions` → 403
- Viewer user attempts `POST /prompts/:id/aliases/:alias/promote` → 403
- Editor user performs same actions → 201/200 (success)
- Admin user generates a personal API key (B1 endpoint) → 201 (admin has key-management rights)
- Editor user attempts `POST /teams/:id/api-keys` → 403

**Member management:**
- Owner removes editor → 204, editor no longer in member list
- Attempt to remove owner → 403 `CANNOT_REMOVE_OWNER`
- Admin attempts to remove self → 403 `CANNOT_REMOVE_SELF`
- PATCH roles to replace `['editor']` with `['viewer']` → 200 with new role set
- PATCH roles of owner → 403 `CANNOT_MODIFY_OWNER`
- Admin PATCHes own roles to `['viewer']` (self-demotion) → 403 `SELF_LOCKOUT`

**Team API keys:**
- `POST /teams/:id/api-keys` → 201 with key shown once
- Use team key to call `GET /prompts` → 200 (editor-level permitted)
- Use team key to call `POST /teams/:id/invites` → 403 `TEAM_KEY_NOT_PERMITTED`
- `DELETE /teams/:id/api-keys/:keyId` → 204, key is revoked
- Use revoked team key → 401

**Invite management:**
- `GET /teams/:id/invites` returns only pending (unused + not expired) invites, token not present
- `DELETE /teams/:id/invites/:inviteId` removes the invite; subsequent `GET` does not include it

---

## Definition of Done

1. Alice (Owner) generates an invite link and shares it with Bob.
2. Bob (unauthenticated) signs up via `POST /auth/signup`, then calls `POST /teams/invites/:token/accept` with his session.
3. `GET /teams/:id/members` shows both Alice (owner) and Bob (editor).
4. Bob calls `POST /prompts/:id/versions` → 201 (editor right confirmed).
5. Alice updates Bob's roles to `['viewer']` via `PATCH /teams/:id/members/:bobId/roles`.
6. Bob calls `POST /prompts/:id/versions` again → 403 (viewer cannot commit).
7. Alice generates a team API key, uses it to call `GET /prompts` → 200.
8. Team API key call to `POST /teams/:id/invites` → 403 (team key cannot manage members).
9. All eight audit events from this session appear in `GET /prompts/:id/audit` (or team audit log).
