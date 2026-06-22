# Phase 1 — Prompt Management: Decomposition

- **Date:** 2026-06-21
- **Status:** Approved decomposition. Each part gets its own spec before build begins.
- **Parent:** [Agentic Platform Roadmap](./2026-06-20-agentic-platform-roadmap-design.md)
- **Builder:** Solo, AI-paired (Claude Code)
- **Cadence:** 1–2 days per backend part, 1–2 days per frontend part (AI pairing compresses a "week of work" to hours or days)

---

## Context & Constraints

- **First user:** dogfooding (solo developer using the platform for their own prompts)
- **No design partner yet** — building to validate the core value proposition
- **Build order:** Backend API + SDK fully complete first, frontend built after all backend parts are done
- **Teams deferred** until a second person actually needs access (Backend Part 5)
- **Single-user first:** auto-create a personal team on signup; no invite UI until the frontend phase

---

## How Might We

> *How might a solo developer build Phase 1 as a backend-first, 1–2 week chunked build — where each backend part produces a tested, documented API endpoint — so that the frontend is built once against a stable, complete contract?*

---

## Build Order Overview

```
Backend Track (Parts 1–6)       →  Frontend Track (Parts 7–11)
~1–2 days each with AI pairing     ~1–2 days each with AI pairing
─────────────────────────────────────────────────────────────────
B1: Schema + Auth API
B2: Prompt CRUD API
B3: Versioning + Env Aliases API
B4: SDK (TypeScript)
B5: Teams + RBAC API
B6: Diff + Audit + Export API
                                    F1: Auth screens
                                    F2: Prompt CRUD screens
                                    F3: Versioning + Aliases UI
                                    F4: Team management UI
                                    F5: Diff + Audit UI
```

**Estimated total:** ~11 parts × ~1–2 days = **2–3 weeks of calendar time** for all of Phase 1.

---

## Backend Track

### Backend Part 1 — Schema + Auth API

**What ships:**
- Postgres schema: `users`, `teams`, `team_members` (join table: user_id, team_id, role), `api_keys`
- Auth: email + password, `express-session` (Postgres session store), bcrypt — no JWT; replaced by Supabase/Google Auth later
- Personal team auto-created on signup (no `type` field — every team is just a team)
- Application-layer `team_id` filtering on all queries; RLS deferred
- API keys stored plain text for now
- `POST /auth/signup` — creates user + auto-creates personal team, starts session
- `POST /auth/login` — starts session
- `POST /auth/logout` — destroys session
- `GET /auth/me` — returns current user + team
- `POST /api-keys` — generate personal API key
- `DELETE /api-keys/:id` — revoke API key

**Done when:** Signup, login, logout, and `/me` all work via curl/Postman. A personal API key can be generated and revoked.

---

### Backend Part 2 — Prompt CRUD + Versioning API

**What ships:**
- Postgres schema:
  - `prompts`: `id`, `name` (mutable — renaming breaks SDK callers intentionally), `description`, `team_id`, `created_by`, `created_at`
  - `prompt_versions`: `id`, `prompt_id`, `version_number` (sequential int per prompt), `messages` (JSONB `[{role, content}]` — raw Jinja2 template strings), `variables` (JSONB array of names extracted from nunjucks AST at commit), `created_by`, `created_at`
  - `prompt_aliases`: `id`, `prompt_id`, `alias`, `version_id` — `production` + `staging` auto-created on first commit
- Templating: **nunjucks** (Jinja2-compatible) on Node.js backend
- Render validation: extra variables → ignore; missing required variables → 400
- Rendered output: OpenAI-compatible messages array `[{ role, content }]`
- `POST /prompts` — create prompt shell
- `GET /prompts` — list prompts for team (search/filter)
- `GET /prompts/:id` — get prompt by ID
- `PATCH /prompts/:id` — update name/description
- `DELETE /prompts/:id` — soft delete
- `POST /prompts/:id/versions` — commit new immutable version (parses nunjucks AST, extracts variables)
- `GET /prompts/:id/versions` — list all versions
- `GET /prompts/:id/versions/:version_number` — get a specific version
- `GET /prompts/:id/aliases` — list aliases + which version each points to
- `POST /prompts/:id/aliases/:alias/promote` — move alias to a version `{ version_number }`
- `POST /prompts/:name/:alias/render` — render with `{ variables: {} }` body, return OpenAI-compatible messages array

**Done when:** A prompt with Jinja2 template content can be committed, promoted to `production`, and rendered with variables via the render endpoint — returning a correct OpenAI-compatible messages array.

---

### Backend Part 3 — Versioning + Env Aliases API

**What ships:**
- Postgres schema: `prompt_versions` (content, variables snapshot, version_number, prompt_id), `prompt_aliases` (alias name, points to version_id)
- `POST /prompts/:id/versions` — create new immutable version (auto-increments version number)
- `GET /prompts/:id/versions` — list all versions for a prompt
- `GET /prompts/:id/versions/:version_number` — get a specific version
- `GET /prompts/:id/aliases` — list aliases and which version each points to
- `POST /prompts/:id/aliases/:alias/promote` — move alias to a version (body: `{ version_number }`)
- Default aliases `production` and `staging` created when first version is saved

**Done when:** A prompt can be saved (version created), promoted to `production`, rolled back to a prior version — all via API.

---

### Backend Part 4 — SDK

**What ships:**
- TypeScript SDK package (`@agenticprompthub/sdk` or similar), Node.js only
- Class-based: `new AgenticHub(config)` with env var fallback (`AGENTICHUB_API_KEY`, `AGENTICHUB_BASE_URL`)
- Constructor options (all optional, with defaults):
  - `apiKey` / `baseUrl`
  - `cacheTtl` (default: 60s)
  - `maxCacheSize` (default: 500 entries)
  - `maxRetries` (default: 1)
  - `retryInterval` (default: 500ms)
- `renderPrompt(name, alias, variables)` → `Promise<Message[]>`
  - Calls `POST /prompts/:name/:alias/render` server-side (thin SDK, no Jinja2 parsing)
  - Returns OpenAI-compatible `[{ role, content }]` — ready to pass directly to any LLM API
- Cache: `lru-cache`, module-level singleton, stale-while-revalidate
  - API unreachable + stale entry → serve stale silently, log warning
  - API unreachable + cold cache → throw after exhausting retries
- SDK ships with TypeScript types (`Message`, `AgenticHubConfig`), README, and at least one end-to-end integration test

**Done when:** A Node.js script using the SDK can call `renderPrompt("my-prompt", "production", { name: "Alice" })` and receive a correct OpenAI-compatible messages array — without touching the database directly.

---

### Backend Part 5 — Diff + Audit Trail + Export/Import API

**What ships:**
- `GET /prompts/:id/versions/diff?from=:v1&to=:v2` — unified diff string (jsdiff `createPatch()`) on raw Jinja2 template strings; frontend renders `-` lines red, `+` lines green
- `GET /prompts/:id/audit` — paginated audit log; events: version committed, alias promoted, alias rolled back, prompt created, prompt deleted, prompt renamed, API key generated, API key revoked
- `GET /prompts/:id/versions/:version_number/export` — single version as JSON `{ name, description, messages, variables }`; round-trip compatible with import
- `POST /prompts/import` — takes export JSON, always creates a new prompt + first version (no merge into existing prompts)
- Audit events written automatically by all mutation endpoints in Parts 1–4

**Done when:** Diff returns a unified diff string between any two versions. Audit log shows full history. A prompt exported as JSON can be imported to create a new prompt with identical content.

---

### Backend Part 6 — Teams + RBAC API

**What ships:**
- Schema: `team_invites` (`id`, `team_id`, `token`, `invited_by`, `roles[]`, `expires_at`, `used_at`), `team_member_roles` (`team_member_id`, `role`)
- Roles: `owner` | `admin` | `editor` | `viewer` (enum); users can hold multiple roles via `team_member_roles` join table; `reviewer` role deferred
- Permissions: Owner + Admin + Editor can promote aliases; Viewer cannot; Admin can manage members but cannot delete team or reassign ownership
- `POST /teams/:id/invites` — generate shareable invite link with role(s); 7-day expiry, single-use
- `POST /teams/invites/:token/accept` — accept invite; creates `team_member` + `team_member_roles` rows
- `GET /teams/:id/members` — list members + their roles
- `PATCH /teams/:id/members/:userId/roles` — update roles (Owner/Admin only)
- `DELETE /teams/:id/members/:userId` — remove member
- `POST /teams/:id/api-keys` — generate team-scoped API key
- `DELETE /teams/:id/api-keys/:keyId` — revoke team-scoped key
- Personal API keys (Part 1) coexist for now; earmarked for deprecation

**Done when:** Two test users in the same team — one Owner, one Viewer — demonstrate that the Viewer cannot commit versions or promote aliases. Invite link generates, is accepted, and the new member appears with correct roles.

---

## Frontend Track

> Frontend begins only after all Backend Parts (1–6) are shipped and tested. The API contract is stable; no backend changes should be needed during the frontend build.

---

### Frontend Part 7 — Auth Screens

- Sign up screen
- Login screen
- "My account" / API key management screen (show personal key, generate new key)
- JWT stored in httpOnly cookie or localStorage (to decide in spec)

---

### Frontend Part 8 — Prompt CRUD Screens

- Prompt list view (search, filter, empty state)
- Create prompt modal / page
- Prompt detail page (name, description, current production version content)
- Edit prompt content: rich textarea with `{{variable}}` live highlighting
- Variable interpolation preview panel: fill in variable values, see rendered output
- Delete prompt

---

### Frontend Part 9 — Versioning + Aliases UI

- Version history list per prompt (version number, created by, created at, which aliases point here)
- "Save as new version" button (calls `POST /prompts/:id/versions`)
- Alias status badges on the prompt detail page (`production → v3`, `staging → v5`)
- "Promote to production / staging" action
- Rollback to any prior version

---

### Frontend Part 10 — Team Management UI

- Team settings page: member list with roles
- Invite member by email
- Change role / remove member (Owner only)
- Team API key management (generate, revoke)

---

### Frontend Part 11 — Diff + Audit UI

- Version diff view: select any two versions, see inline or side-by-side diff
- Audit trail view: paginated log per prompt
- Export button (download version as JSON or plain text)

---

## What We're Not Doing (and Why)

| Deferred | Reason |
|----------|--------|
| Multi-member teams until Backend Part 5 | Solo dogfood — no one else needs access yet |
| LLM calls / playground | Explicitly Phase 2 (requires the gateway) |
| Org layer | Additive parent to teams, deferred by foundational decision |
| OAuth / SSO | Unnecessary before real external users exist |
| Import from PromptLayer / Langfuse | Nice to have, not blocking adoption |
| Complex template logic (Jinja/Handlebars) | `{{variable}}` substitution only |
| Webhooks | No downstream consumers yet |
| More than 2 env aliases (production + staging) | Two is enough to prove the model |
| Fetch by version number in SDK | Alias-based fetch is the primary use case |
| Redis caching in SDK | In-memory cache ships first in Backend Part 4; Redis is a later upgrade |
| Per-prompt / per-resource ACLs | Team-level RBAC only (foundational decision) |

---

## Key Assumptions

| Assumption | Category | How to test |
|-----------|----------|-------------|
| Email/password auth is sufficient for dogfood | Must be true | Use it yourself; add OAuth if you feel friction |
| `{{variable}}` interpolation covers real use cases without logic | Must be true | Dogfood with real prompts during Backend Part 2–3 |
| Prompt content lives on versions, not the prompt record | Must be true | Validate the schema decision before writing migrations |
| A personal API key suffices before team keys (Parts 1–4) | Should be true | Upgrade to team keys in Part 5 |
| Text diff is actually wanted | Might be true | Validate before building Part 6; defer if no demand |

---

## Open Questions (to resolve in each part's spec)

- **Backend Part 1:** httpOnly cookie vs. Authorization header for JWT — which fits the SDK + frontend setup better?
- **Backend Part 2:** Should `prompt.name` be unique per team (used as the SDK lookup key), or is that the alias? *(Likely name is the stable identifier for SDK fetch.)*
- **Backend Part 4:** Should the SDK support both Node.js and browser environments in the initial release, or Node.js only?
- **Frontend Part 8:** Client-side variable interpolation preview only, or does the server also render filled prompts (for the export use case)?

---

## Definition of Done (Phase 1 complete)

A developer (you) fetches a `production` alias prompt at runtime via the SDK, edits the content in the UI, promotes the new version to `production`, and the next SDK fetch returns the updated content — **without touching or deploying application code**.
