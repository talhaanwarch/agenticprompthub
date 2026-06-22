# Backend Part 3 — Versioning + Env Aliases API

- **Date:** 2026-06-22
- **Status:** Draft
- **Phase:** 1 — Prompt Management
- **Depends on:** B1 (auth, session middleware, requireAuth, API key auth), B2 (prompts table, audit helper)
- **Blocks:** B4 (SDK calls the render endpoint)

---

## Overview

This part makes prompts versionable. Users commit immutable snapshots of prompt content; aliases (`production`, `staging`) point to specific versions and can be moved without a code deploy. The render endpoint is the core runtime value proposition — it resolves an alias to a version, renders the nunjucks template with caller-supplied variables, and returns an OpenAI-compatible messages array ready to pass to any LLM API.

**Definition of done:** A prompt can have its content committed as version 1 (auto-creating `production` and `staging` aliases), a second version committed, `production` promoted to v2, and then rendered via the render endpoint — returning the correctly interpolated messages array.

---

## Database Schema

```sql
CREATE TABLE prompt_versions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id      UUID        NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL,
  messages       JSONB       NOT NULL,
  variables      JSONB       NOT NULL DEFAULT '[]',
  created_by     UUID        NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version_number)
);

CREATE INDEX idx_prompt_versions_lookup
  ON prompt_versions (prompt_id, version_number);

CREATE INDEX idx_prompt_versions_list
  ON prompt_versions (prompt_id, created_at DESC);


CREATE TABLE prompt_aliases (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id  UUID        NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  alias      TEXT        NOT NULL,
  version_id UUID        NOT NULL REFERENCES prompt_versions(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, alias)
);

CREATE INDEX idx_prompt_aliases_lookup
  ON prompt_aliases (prompt_id, alias);
```

### Schema decisions

- `version_number` is per-prompt sequential (1, 2, 3…), not globally unique. Computed at insert time with `SELECT COALESCE(MAX(version_number), 0) + 1 FROM prompt_versions WHERE prompt_id = $1`.
- `messages` JSONB stores an array of `{ "role": "system"|"user"|"assistant", "content": "<nunjucks template string>" }`. Content fields are raw nunjucks template strings — never pre-rendered.
- `variables` JSONB stores a sorted array of extracted variable name strings, e.g. `["name", "role", "task"]`. Extracted once at commit time; never re-parsed at render time.
- `prompt_aliases.alias` is free-form text. `production` and `staging` are auto-created; users may create additional aliases.

---

## Nunjucks Variable Extraction

At commit time, variables are extracted from the nunjucks AST and stored. This powers both frontend field rendering and server-side validation at render time.

**Algorithm:**

```typescript
import * as nunjucks from 'nunjucks';

function extractVariables(messages: { content: string }[]): string[] {
  const env = new nunjucks.Environment();
  const vars = new Set<string>();

  for (const msg of messages) {
    const ast = env.parse(msg.content);   // throws NunjucksError on invalid syntax
    walkAst(ast, vars);
  }

  return Array.from(vars).sort();
}

function walkAst(node: any, vars: Set<string>): void {
  if (!node || typeof node !== 'object') return;

  // Top-level variable references: {{ name }}
  if (node.typename === 'Symbol') {
    vars.add(node.value);
  }
  // Attribute access: {{ user.name }} — capture root 'user'
  if (node.typename === 'LookupVal' && node.target?.typename === 'Symbol') {
    vars.add(node.target.value);
  }

  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;    // avoid circular refs
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => walkAst(c, vars));
    } else if (child && typeof child === 'object') {
      walkAst(child, vars);
    }
  }
}
```

**Examples:**
- `"Hello {{ name }}"` → `["name"]`
- `"{% if role == 'admin' %}..."` → `["role"]`
- `"{{ user.name }} — {{ task }}"` → `["task", "user"]` (root of `user.name` captured)
- No variables → `[]`

**nunjucks config:** `autoescape: false` — prompt content is not HTML; escaping would corrupt LLM output.

---

## API Endpoints

All endpoints are scoped to the current user's team via `team_id` from session or API key context. All mutating endpoints require `requireRole`.

---

### POST /prompts/:id/versions

Commit a new immutable version for a prompt.

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')`

**Request body:**
```json
{
  "messages": [
    { "role": "system",  "content": "You are a helpful assistant for {{ company }}." },
    { "role": "user",    "content": "Answer this: {{ question }}" }
  ]
}
```

**Validation:**
- `messages` must be a non-empty array.
- Each message must have `role` ∈ `['system', 'user', 'assistant']` and `content` as a non-empty string.
- Each `content` string is parsed with `nunjucks.Environment().parse()`. If parsing throws, return 400 immediately.

**Logic:**
1. Verify prompt exists and belongs to the current team; 404 if not.
2. Compute `version_number = SELECT COALESCE(MAX(version_number), 0) + 1 FROM prompt_versions WHERE prompt_id = $id`.
3. Extract variables via `extractVariables(messages)`.
4. Insert `prompt_versions` row.
5. If `version_number === 1`: insert `production` and `staging` rows into `prompt_aliases`, both pointing to the new version.
6. Emit audit event `version_committed`.

**Response 201:**
```json
{
  "id": "uuid",
  "promptId": "uuid",
  "versionNumber": 1,
  "messages": [...],
  "variables": ["company", "question"],
  "createdBy": "uuid",
  "createdAt": "2026-06-22T10:00:00Z",
  "aliases": [
    { "alias": "production", "versionId": "uuid" },
    { "alias": "staging",    "versionId": "uuid" }
  ]
}
```

The `aliases` field is present only when `versionNumber === 1`. Omitted on subsequent versions.

**Errors:**
- 400 `VALIDATION_ERROR` — missing/invalid fields
- 400 `TEMPLATE_PARSE_ERROR` — nunjucks syntax error; message contains nunjucks error text
- 403 — Viewer role
- 404 — prompt not found or not in team

---

### GET /prompts/:id/versions

List all versions for a prompt, newest first.

**Auth:** `requireAuth` (any role)

**Query params:** `page` (default 1), `limit` (default 20, max 100)

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "versionNumber": 2,
      "variables": ["company", "question"],
      "createdBy": "uuid",
      "createdAt": "2026-06-22T11:00:00Z"
    }
  ],
  "total": 2,
  "page": 1,
  "limit": 20
}
```

`messages` is excluded from list responses to keep payloads small. Use the single-version endpoint to fetch content.

**Errors:**
- 404 — prompt not found or not in team

---

### GET /prompts/:id/versions/:version_number

Fetch a specific version including full message content.

**Auth:** `requireAuth` (any role)

**Response 200:**
```json
{
  "id": "uuid",
  "promptId": "uuid",
  "versionNumber": 1,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant for {{ company }}." },
    { "role": "user",   "content": "Answer this: {{ question }}" }
  ],
  "variables": ["company", "question"],
  "createdBy": "uuid",
  "createdAt": "2026-06-22T10:00:00Z"
}
```

**Errors:**
- 404 — prompt not found, not in team, or version number does not exist for this prompt

---

### GET /prompts/:id/aliases

List all aliases for a prompt with their target version details.

**Auth:** `requireAuth` (any role)

**Response 200:**
```json
[
  {
    "id": "uuid",
    "alias": "production",
    "versionId": "uuid",
    "versionNumber": 2,
    "updatedAt": "2026-06-22T12:00:00Z"
  },
  {
    "id": "uuid",
    "alias": "staging",
    "versionId": "uuid",
    "versionNumber": 1,
    "updatedAt": "2026-06-22T10:00:00Z"
  }
]
```

`versionNumber` is joined from `prompt_versions`.

**Errors:**
- 404 — prompt not found or not in team

---

### POST /prompts/:id/aliases/:alias/promote

Move an alias to point to a different version. Works for `production`, `staging`, and any user-created alias. Creates the alias row if it does not yet exist (for custom aliases).

**Auth:** `requireAuth` + `requireRole('owner', 'admin', 'editor')`

**Request body:**
```json
{ "version_number": 2 }
```

**Logic:**
1. Verify prompt exists and belongs to current team.
2. Verify `version_number` exists for this prompt; 404 if not.
3. Read the current `version_id` for this alias (for audit metadata). If the alias doesn't exist yet, `fromVersionNumber` is `null`.
4. Upsert `prompt_aliases` row: `INSERT ... ON CONFLICT (prompt_id, alias) DO UPDATE SET version_id = ..., updated_at = now()`.
5. Emit audit event `alias_promoted`.

**Response 200:**
```json
{
  "id": "uuid",
  "alias": "production",
  "versionId": "uuid",
  "versionNumber": 2,
  "updatedAt": "2026-06-22T12:00:00Z"
}
```

**Errors:**
- 400 `VALIDATION_ERROR` — `version_number` missing or not an integer
- 403 — Viewer role
- 404 — prompt not found, not in team, or version not found

---

### POST /prompts/:name/:alias/render

Resolve an alias to a version and render the nunjucks template with caller-supplied variables. Returns an OpenAI-compatible messages array.

**Auth:** `requireAuth` — accepts both session cookies and `Authorization: Bearer <api-key>` header. This is the primary SDK-facing endpoint.

**Params:** `:name` = prompt name (mutable identifier), `:alias` = alias name (e.g. `production`)

**Request body:**
```json
{
  "variables": {
    "company": "Acme Corp",
    "question": "What are your hours?"
  }
}
```

**Lookup sequence:**
1. Find prompt: `SELECT id FROM prompts WHERE team_id = $teamId AND name = $name AND deleted_at IS NULL`. 404 if not found.
2. Find alias: join `prompt_aliases` + `prompt_versions` for `(prompt_id, alias)`. 404 if alias not found.
3. Load `messages` and `variables` from the resolved version.

**Variable validation:**
- For each name in `version.variables`: if not present as a key in `request.variables` → collect into `missing[]`.
- If `missing` is non-empty → 400.
- Extra keys in `request.variables` not in `version.variables` → silently ignored.

**Rendering:**
```typescript
const env = new nunjucks.Environment(null, { autoescape: false });
const rendered = version.messages.map(msg => ({
  role: msg.role,
  content: env.renderString(msg.content, variables),
}));
```

**Response 200:**
```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant for Acme Corp." },
    { "role": "user",   "content": "Answer this: What are your hours?" }
  ]
}
```

**Errors:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `MISSING_VARIABLES` | Required template variables absent from request body |
| 404 | — | Prompt name not found for team, or alias not found |
| 422 | `TEMPLATE_RENDER_ERROR` | nunjucks runtime error during rendering (e.g. filter on undefined) |

**400 MISSING_VARIABLES body:**
```json
{
  "error": {
    "code": "MISSING_VARIABLES",
    "message": "Required variables are missing: company, question",
    "missing": ["company", "question"]
  }
}
```

---

## Authorization

| Action | Owner | Admin | Editor | Viewer |
|--------|-------|-------|--------|--------|
| Commit version | ✓ | ✓ | ✓ | ✗ |
| List / get versions | ✓ | ✓ | ✓ | ✓ |
| List aliases | ✓ | ✓ | ✓ | ✓ |
| Promote alias | ✓ | ✓ | ✓ | ✗ |
| Render (session) | ✓ | ✓ | ✓ | ✓ |
| Render (API key) | ✓ | ✓ | ✓ | ✓ |

Viewer cannot commit or promote. 403 returned with `{ "error": "Insufficient role" }`.

---

## Audit Events

All events are written via the `audit(db, { teamId, userId, event, resourceId, metadata })` helper established in B2.

| Event | Trigger | Metadata |
|-------|---------|----------|
| `version_committed` | POST /prompts/:id/versions | `{ promptId, versionNumber }` |
| `alias_promoted` | POST /prompts/:id/aliases/:alias/promote | `{ promptId, alias, fromVersionNumber, toVersionNumber }` |

`alias_promoted` covers both promotions (moving forward) and rollbacks (moving backward). `fromVersionNumber` is `null` when the alias is newly created. The direction of change is determined by comparing `fromVersionNumber` and `toVersionNumber`.

---

## Error Handling

All errors follow the standard envelope:
```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

Or for simple 403/404:
```json
{ "error": "Not found" }
```

| Scenario | Status | Code |
|----------|--------|------|
| Invalid messages array | 400 | `VALIDATION_ERROR` |
| Nunjucks parse error at commit | 400 | `TEMPLATE_PARSE_ERROR` |
| Missing required render variables | 400 | `MISSING_VARIABLES` |
| Prompt/version/alias not found | 404 | — |
| Viewer attempts commit or promote | 403 | — |
| Nunjucks runtime error at render | 422 | `TEMPLATE_RENDER_ERROR` |

---

## Testing

**Version commit:**
- `POST /prompts/:id/versions` with valid messages → 201, version_number = 1, `aliases` in response with `production` and `staging`
- Second commit → 201, version_number = 2, no `aliases` in response
- Commit with invalid nunjucks syntax (`{{ unclosed`) → 400 `TEMPLATE_PARSE_ERROR`
- Commit with missing `messages` field → 400 `VALIDATION_ERROR`
- Commit with invalid role (e.g. `role: 'tool'`) → 400 `VALIDATION_ERROR`
- Viewer attempts commit → 403

**Alias operations:**
- `GET /prompts/:id/aliases` after first commit → returns `production` → v1, `staging` → v1
- `POST /prompts/:id/aliases/production/promote` with `version_number: 2` → 200, alias now points to v2
- `GET /prompts/:id/aliases` → `production` → v2, `staging` → v1
- Promote with non-existent version_number → 404
- Promote with Viewer role → 403
- Promote to custom alias (not production/staging) → 200, alias created

**Version listing and fetch:**
- `GET /prompts/:id/versions` returns newest first; `messages` field absent
- `GET /prompts/:id/versions/1` returns full messages content
- `GET /prompts/:id/versions/99` (non-existent) → 404

**Render:**
- Render `production` after promotion to v2 → 200, rendered content from v2
- Render with all required variables → correct interpolated messages array
- Render with extra variables → 200, extra ignored
- Render with missing required variable → 400 `MISSING_VARIABLES`, `missing` array lists each absent name
- Render unknown prompt name → 404
- Render unknown alias → 404
- Render via API key auth (no session) → 200
- Variables extracted correctly: `{{ name }}` → `["name"]`; `{% if role == 'admin' %}` → `["role"]`; `{{ user.name }}` → `["user"]`

---

## Definition of Done

1. `POST /prompts/:id/versions` creates version 1, auto-creates `production` and `staging` aliases pointing to it.
2. Committing version 2 does not move aliases.
3. `POST /prompts/:id/aliases/production/promote` with `{ version_number: 2 }` moves `production` to v2.
4. `POST /prompts/:name/production/render` with all required variables returns a valid OpenAI-compatible messages array with all `{{ variable }}` placeholders replaced.
5. All test cases above pass.
6. Viewer cannot commit versions or promote aliases (403).
