# Backend Part 5 — Diff + Audit Trail + Export/Import API

- **Date:** 2026-06-22
- **Status:** Draft
- **Phase:** 1 — Prompt Management
- **Depends on:** B1 (auth + session middleware), B2 (prompts table + audit_log table + audit() helper), B3 (prompt_versions + prompt_aliases)
- **Blocks:** Nothing (additive read/portability capabilities on top of existing data)

---

## Overview

This part adds three read/portability capabilities to the existing version data. It introduces no new tables — all data already exists from B1–B3.

**Diff:** Compare any two versions of a prompt as a unified diff string (git-style). The diff compares raw nunjucks template strings, not rendered output. This lets users see exactly what changed between versions without needing variable values.

**Audit log:** Read the `audit_log` table (written by B1–B6 mutation endpoints via the shared `audit()` helper). Returns a paginated, reverse-chronological log of who did what to a prompt.

**Export/Import:** Export a single prompt version as a portable JSON file. Import that file to create a new prompt in any team. The format is round-trip compatible and schema-versioned.

**Definition of done:** Diff returns a unified diff string between any two versions. Audit log shows full history for a prompt. A prompt exported as JSON can be imported to create a new prompt with identical content.

---

## Database Schema Reference

No new tables. The `audit_log` table is created in B2 and written by all mutation endpoints across B1–B6.

### `audit_log` (created in B2)

```sql
CREATE TABLE audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id),
  prompt_id  UUID REFERENCES prompts(id),   -- NULL for team-level events
  actor_id   UUID NOT NULL REFERENCES users(id),
  event      TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_prompt_id_created_at ON audit_log (prompt_id, created_at DESC);
CREATE INDEX audit_log_team_id_created_at   ON audit_log (team_id, created_at DESC);
```

### Event types by part

| Part | Event name | Metadata fields |
|------|-----------|-----------------|
| B1 | `api_key_generated` | `{ keyId }` |
| B1 | `api_key_revoked` | `{ keyId }` |
| B2 | `prompt_created` | `{ promptId, name }` |
| B2 | `prompt_renamed` | `{ promptId, oldName, newName }` |
| B2 | `prompt_deleted` | `{ promptId, name }` |
| B3 | `version_committed` | `{ promptId, versionNumber }` |
| B3 | `alias_promoted` | `{ promptId, alias, fromVersionNumber, toVersionNumber }` |
| B6 | `member_invited` | `{ inviteeEmail, roles }` |
| B6 | `member_role_updated` | `{ targetUserId, oldRoles, newRoles }` |
| B6 | `member_removed` | `{ targetUserId }` |

The B5 endpoints only **read** this table — no new events are written by B5.

---

## API Endpoints

All endpoints require `requireAuth` (valid session or API key). The team scope is always enforced: prompts are looked up with `WHERE id = :id AND team_id = req.teamId`.

---

### GET /prompts/:id/versions/diff

Returns a unified diff string between two versions of a prompt.

**Auth:** `requireAuth` (any role including Viewer)

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | integer | yes | Version number to diff from |
| `to` | integer | yes | Version number to diff to |

**Validation:**
- `from` and `to` must both be present — 400 if either is missing
- Both must be positive integers — 400 if not
- Both versions must exist for this prompt — 404 if either is missing

**Behaviour:**
1. Fetch the prompt (404 if not found for team)
2. Fetch both `prompt_versions` rows for this prompt where `version_number IN (from, to)`
3. Concatenate each version's messages array into a text block using the format below
4. Run `createPatch()` from the `diff` npm package on the two text blocks
5. Return the result

Comparing a version to itself (`from === to`) returns an empty diff string — this is valid, not an error.

**Diff text serialisation:**

```
[system]
You are a {{ role }} assistant...

---

[user]
{{ task }}
```

Each message is formatted as `[${role}]\n${content}`, separated by `\n\n---\n\n`.

**`createPatch` call:**

```javascript
import { createPatch } from 'diff';

const label = `${prompt.name} v${from}..v${to}`;
const diffString = createPatch(label, fromText, toText);
```

**Response 200:**

```json
{
  "diff": "--- prompt-name v1..v2\n+++ prompt-name v1..v2\n@@ -1,3 +1,3 @@...",
  "fromVersion": 1,
  "toVersion": 2
}
```

**Error responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | `from` or `to` missing or not a positive integer |
| 404 | `NOT_FOUND` | Prompt not found in team, or either version number not found |

---

### GET /prompts/:id/audit

Returns a paginated, reverse-chronological audit log for a specific prompt.

**Auth:** `requireAuth` (any role including Viewer)

**Query parameters:**

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `page` | integer | 1 | — | Page number (1-indexed) |
| `limit` | integer | 20 | 100 | Records per page |

**Behaviour:**
1. Verify the prompt exists in `req.teamId` (404 if not)
2. Query `audit_log WHERE team_id = req.teamId AND prompt_id = :id ORDER BY created_at DESC`
3. Apply offset/limit pagination
4. JOIN with `users` to return actor email

**Response 200:**

```json
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "event": "alias_promoted",
      "actor": {
        "id": "u1b2c3d4-...",
        "email": "alice@example.com"
      },
      "metadata": {
        "alias": "production",
        "fromVersionNumber": 1,
        "toVersionNumber": 2
      },
      "createdAt": "2026-06-22T14:30:00.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

**Error responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `NOT_FOUND` | Prompt not found in team |

**Scope note:** This endpoint filters by `prompt_id`. Events without a `prompt_id` (e.g. `api_key_generated`, team-level events from B6) are team-level and will not appear here.

---

### GET /prompts/:id/versions/:version_number/export

Downloads a single prompt version as a portable JSON file.

**Auth:** `requireAuth` (any role including Viewer)

**Path parameters:** `:id` (prompt UUID), `:version_number` (positive integer)

**Behaviour:**
1. Fetch the prompt (404 if not found for team)
2. Fetch the `prompt_versions` row for `(prompt_id = :id, version_number = :version_number)` (404 if not found)
3. Build the export object
4. Set response headers and return JSON

**Response headers:**

```
Content-Type: application/json
Content-Disposition: attachment; filename="<promptName>-v<version_number>.json"
```

**Response body 200:**

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-06-22T14:30:00.000Z",
  "prompt": {
    "name": "customer-support-greeting",
    "description": "Greeting message for support chat"
  },
  "version": {
    "versionNumber": 3,
    "messages": [
      { "role": "system", "content": "You are a {{ role }} assistant." },
      { "role": "user", "content": "Help me with {{ task }}." }
    ],
    "variables": ["role", "task"],
    "createdAt": "2026-06-21T10:00:00.000Z"
  }
}
```

- `description` may be `null` if the prompt has no description
- `variables` is the stored snapshot from the nunjucks AST parse at commit time

**Error responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `NOT_FOUND` | Prompt not found in team, or version number not found |

---

### POST /prompts/import

Imports an exported prompt JSON to create a new prompt with a first version.

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')` — Viewers cannot import

**Request body:** The export JSON object produced by the export endpoint.

**Validation:**
- `schemaVersion` must equal `1` — 400 with code `UNSUPPORTED_SCHEMA_VERSION` if not
- `prompt.name` must be present and non-empty string — 400 with code `VALIDATION_ERROR`
- `version.messages` must be a non-empty array where each element has `role` (string) and `content` (string) — 400 with code `VALIDATION_ERROR`

**Behaviour (inside a transaction):**
1. Validate the body
2. Determine the prompt name:
   - Use `prompt.name` from the import JSON
   - If a prompt with that name already exists in `req.teamId`, append `-imported-<unix_timestamp_ms>` (e.g. `my-prompt-imported-1750600000000`)
3. Create a new `prompts` row (`id` = new UUID, `team_id` = `req.teamId`, `created_by` = `req.userId`)
4. Re-extract variables from `version.messages[*].content` using the nunjucks AST parser (do not trust the imported `variables` array)
5. Create a new `prompt_versions` row: `version_number = 1`, `messages` from import body, `variables` from step 4
6. Create `production` and `staging` aliases pointing to version 1 (same as normal first commit in B3)
7. Write `prompt_created` to `audit_log`
8. Return 201

**Response 201:**

```json
{
  "prompt": {
    "id": "new-uuid",
    "name": "customer-support-greeting"
  },
  "version": {
    "id": "version-uuid",
    "versionNumber": 1
  }
}
```

**Error responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `UNSUPPORTED_SCHEMA_VERSION` | `schemaVersion` is not `1` |
| 400 | `VALIDATION_ERROR` | `prompt.name` missing, `version.messages` invalid |

Name collisions are resolved automatically (suffix appended), never returned as an error.

---

## Diff Implementation Detail

Diffs compare **raw nunjucks template strings** stored in `prompt_versions.messages`. Rendered output is never diffed — there are no variable values at version commit time, and the intent is to show what changed in the prompt definition.

### Message serialisation

```typescript
function messagesToDiffText(messages: { role: string; content: string }[]): string {
  return messages
    .map(m => `[${m.role}]\n${m.content}`)
    .join('\n\n---\n\n');
}
```

### createPatch call

```typescript
import { createPatch } from 'diff';

const fromText = messagesToDiffText(fromVersion.messages);
const toText   = messagesToDiffText(toVersion.messages);
const label    = `${prompt.name} v${from}..v${to}`;

const diffString = createPatch(label, fromText, toText);
```

`createPatch` produces a standard unified diff header followed by `@@` hunks with `-` and `+` lines. The frontend renders `-` lines red and `+` lines green.

Empty diff (same version or identical content) returns a header with no hunks — the `diff` field in the response is that string, not null.

---

## Export Format

### Schema

```typescript
interface ExportFile {
  schemaVersion: 1;
  exportedAt: string;          // ISO 8601
  prompt: {
    name: string;
    description: string | null;
  };
  version: {
    versionNumber: number;
    messages: Array<{ role: string; content: string }>;
    variables: string[];       // snapshot at commit time; re-derived on import
    createdAt: string;         // ISO 8601
  };
}
```

### Versioning contract

- `schemaVersion: 1` is the only supported version in Phase 1
- The import endpoint rejects any `schemaVersion !== 1` with 400 `UNSUPPORTED_SCHEMA_VERSION`
- Future format changes bump `schemaVersion` and the import handler adds a branch for each version

### Scope

- Single version per file — no bulk export
- JSON only — plain text excluded because plain text cannot be re-imported

---

## Error Handling

All error responses follow the B1 envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Prompt not found."
  }
}
```

| HTTP | Code | Used by |
|------|------|---------|
| 400 | `VALIDATION_ERROR` | Missing/invalid query params, invalid import body |
| 400 | `UNSUPPORTED_SCHEMA_VERSION` | Import with unknown schemaVersion |
| 401 | `UNAUTHORIZED` | No valid session or API key |
| 403 | `FORBIDDEN` | Viewer attempting import |
| 404 | `NOT_FOUND` | Prompt not found, version not found |
| 500 | `INTERNAL_ERROR` | Unhandled exceptions |

---

## Testing

| # | Test | Expected |
|---|------|----------|
| 1 | Diff v1 vs v2 with changed content | 200, diff string contains `+` and `-` lines |
| 2 | Diff same version (from=1, to=1) | 200, diff string with header and no hunks |
| 3 | Diff missing `from` param | 400 `VALIDATION_ERROR` |
| 4 | Diff non-existent version number | 404 `NOT_FOUND` |
| 5 | Diff prompt not in team | 404 `NOT_FOUND` |
| 6 | Audit log — events returned newest first | 200, `data[0].createdAt` > `data[1].createdAt` |
| 7 | Audit log — events from other prompts not included | 200, all items have `prompt_id = :id` |
| 8 | Audit log — `page=2&limit=5` returns correct slice | 200, correct offset applied |
| 9 | Audit log for non-existent prompt | 404 `NOT_FOUND` |
| 10 | Export returns JSON with correct schema | 200, all fields present, `Content-Disposition` header set |
| 11 | Export prompt not found | 404 `NOT_FOUND` |
| 12 | Export version not found | 404 `NOT_FOUND` |
| 13 | Import creates new prompt, version 1, two aliases | 201, prompt in DB, aliases `production` + `staging` → v1 |
| 14 | Import re-extracts variables from template | imported `variables` array ignored; DB has re-derived variables |
| 15 | Import name collision | 201, prompt name gets `-imported-<ts>` suffix |
| 16 | Import with `schemaVersion: 2` | 400 `UNSUPPORTED_SCHEMA_VERSION` |
| 17 | Import with missing `prompt.name` | 400 `VALIDATION_ERROR` |
| 18 | Import with invalid `version.messages` | 400 `VALIDATION_ERROR` |
| 19 | Import by Viewer role | 403 `FORBIDDEN` |
| 20 | Export then import round-trip | imported prompt content identical to original |

---

## Definition of Done

- `GET /prompts/:id/versions/diff` returns a unified diff string between any two version numbers
- `GET /prompts/:id/audit` returns a paginated, reverse-chronological list of events for the prompt
- `GET /prompts/:id/versions/:version_number/export` returns a download with `Content-Disposition` header and correct JSON schema
- `POST /prompts/import` creates a new prompt + version 1 + `production`/`staging` aliases from an export file, re-extracting variables
- All 20 test cases above pass
- Import with `schemaVersion !== 1` is rejected with 400
- Name collisions on import are resolved automatically with a suffix
