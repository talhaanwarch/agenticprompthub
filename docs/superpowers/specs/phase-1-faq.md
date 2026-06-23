# Phase 1 — Technical Decision FAQ

- **Date:** 2026-06-21
- **Source:** interview-me sessions for Backend Parts 1 & 2
- **Purpose:** Capture the *why* behind every decision so future sessions don't re-litigate them

---

## Auth & Sessions

**Q: Why no JWT?**
JWT will be replaced by Supabase Auth or Google Auth later. Building a full JWT implementation (expiry, refresh tokens, rotation) now is wasted work. `express-session` with bcrypt is the simplest thing that works for dogfood, and it's trivially swappable when real auth arrives.

**Q: What's the session strategy?**
`express-session` with a Postgres session store, bcrypt for password hashing. Email + password only. No OAuth, no email verification, no invite codes in Phase 1.

**Q: Why no Postgres RLS in Phase 1?**
Application-layer `team_id` filtering (`WHERE team_id = $currentTeamId`) is enough for solo dogfood — there's no real multi-tenant isolation risk until real users exist. RLS adds debugging friction (policy errors mid-build are painful). RLS will be retrofitted once the schema stabilises and real users are onboarded.

---

## Schema

**Q: Why a `team_members` join table instead of `team_id` on `users`?**
A join table (`user_id`, `team_id`, `role`) supports multi-team membership and per-team roles. Putting `team_id` directly on `users` would require a migration when Backend Part 5 (multi-member teams) arrives. The join table is 5 lines of SQL now vs a schema migration later.

**Q: Does the `teams` table have a `type` field (personal vs workspace)?**
No. Every team is just a team. When org support arrives (post-Phase 1), it will be an additive parent table above teams — not a type on the team itself.

**Q: Are API keys hashed in the DB?**
No, plain text for now. There are no external users in Parts 1–4, so the security risk is minimal. Will be upgraded to a hash-on-store / show-once pattern before real users are onboarded.

---

## Prompt Names & Identity

**Q: Is `prompt.name` a stable, immutable identifier?**
No — `prompt.name` is mutable. If the name changes, any SDK caller using the old name will get a 404. This is intentional; renaming a prompt in production is a breaking change and should be treated as such. No slug/alias layer to abstract this away — keep it simple.

---

## Prompt Content & Templating

**Q: What format is prompt content stored in?**
A JSONB messages array: `[{ "role": "system|user|assistant", "content": "<Jinja2 template string>" }]`. This mirrors the OpenAI chat format and supports system prompts, multiple user turns, and assistant messages — all with Jinja2 templates.

**Q: Why Jinja2 instead of simple `{{variable}}` substitution?**
Simple substitution only supports value replacement. Jinja2 enables conditional rendering (`{% if user_type == 'admin' %}...{% endif %}`), loops, and filters — which are needed to render different prompt pieces based on variable values. Variables serve dual purpose: Jinja2 logic variables and simple substitution variables.

**Q: Why nunjucks instead of a Python sidecar for Jinja2?**
No Python in this project. nunjucks is the most mature Jinja2-compatible library for Node.js and covers ~95% of Jinja2 syntax — enough for prompt templates. A Python sidecar was earmarked for Phase 2+ (gateway, eval); it's not needed here.

**Q: Are variables extracted and stored, or just left in the raw template?**
Extracted at commit time using the nunjucks AST parser and stored as a JSONB array (`["role", "user_type", "task"]`) on the `prompt_versions` record. This lets the frontend render variable input fields and lets the API validate that required variables are provided at render time — without re-parsing the template on every request.

**Q: What's the variable validation rule at render time?**
- Extra variables sent by the caller but not in the template → **ignore silently**
- Variables defined in the template but not sent by the caller → **return 400**

Silently rendering `""` for missing variables produces broken prompts that are hard to debug.

**Q: Why is the render endpoint `POST /prompts/:name/:alias/render` and not `GET`?**
Variables are JSON (can include strings, booleans, arrays for Jinja2 conditionals). Encoding arbitrary JSON as query params breaks with complex values. POST with a JSON body `{ variables: { ... } }` is clean and unambiguous even if it feels slightly non-REST for a "fetch" operation.

**Q: What does the render endpoint return?**
An OpenAI-compatible messages array: `[{ "role": "system", "content": "..." }, ...]`. This is ready to pass directly into any LLM API (`openai.chat.completions.create({ messages: [...] })`) without transformation.

---

## Versioning & Aliases

**Q: Is version creation automatic (on every save) or explicit?**
Explicit — the user edits content freely as a draft, then hits "commit" to create a new immutable version. Auto-saving every edit as a version would create thousands of versions and make the history unusable.

**Q: How are aliases created?**
`production` and `staging` are auto-created pointing to version 1 when the first commit is made on a prompt. Additional aliases are user-created.

**Q: Can the SDK fetch by version number?**
Not in the initial SDK release. Alias-based fetch (`production`, `staging`) is the primary use case. Version-number fetch is deferred.

---

## Teams + RBAC

**Q: How does the invite flow work?**
Shareable invite link — inviter generates a link, shares it manually (Slack, email, etc.). No email service dependency in Phase 1. AWS SES will be added later as an optional invite-by-email path.

**Q: What roles exist and what is the hierarchy?**
Owner > Admin > Editor > Viewer (+ future Reviewer). Admin added now because the pattern is observed in practice: Owner is the team creator (typically one); Admin has near-Owner rights (manage members, settings, API keys) but cannot delete the team or reassign ownership; Editor creates/edits/commits/promotes; Viewer is read-only. Roles stored in `team_member_roles` join table — a user can hold multiple roles.

**Q: Who can promote an alias to production?**
Owner + Admin + Editor can promote. Viewer cannot. A future `reviewer` role will refine this: Editor edits only, Reviewer promotes.

**Q: Can a user have multiple roles?**
Yes — `team_member_roles` join table (`team_member_id`, `role`) instead of a single `role` enum column on `team_members`. Adding new roles later (e.g. `reviewer`) is an `INSERT`, not a schema migration. Built this way from Part 6 even though only Owner/Editor/Viewer exist today.

**Q: How long are invite links valid?**
7 days, single-use — token deleted on acceptance. Long enough not to rush; short enough to limit leaked-link risk.

**Q: Do personal API keys get deprecated when team-scoped keys arrive in Part 6?**
Not immediately — both coexist in Part 6 so existing dogfood integrations keep working. Personal keys are earmarked for deprecation later; the intent is to make team-scoped keys the only option so developers don't build bad habits around personal keys.

---

## Diff + Audit Trail + Export

**Q: What does the diff compare — raw Jinja2 templates or rendered output?**
Raw Jinja2 template strings stored in `messages`. Rendered diffs would require variable values at commit time — extra complexity with no benefit for a "what changed in the prompt" view.

**Q: What format does the diff endpoint return?**
Unified diff string (git diff style). Frontend renders `-` lines red, `+` lines green. Library: `diff` (jsdiff), `createPatch()` on raw template strings. No structured JSON operations needed — a simple colored diff is sufficient.

**Q: Which events does the audit trail log?**
Version committed, alias promoted, alias rolled back, prompt created, prompt deleted, prompt renamed, API key generated, API key revoked. API key events included because knowing who generated or rotated a key is valuable when debugging production issues.

**Q: What does the export format look like and can it be imported?**
Export is JSON only — plain text is excluded because it can't be re-imported. The format must be round-trip compatible (export → share → import). Single version per export file.

**Q: Does export include one version or all versions?**
Single version only — the use case is sharing a specific prompt. All-version export creates import ambiguity ("which version becomes production?").

**Q: Does import create a new prompt or merge into an existing one?**
Always creates a new prompt. No collision/merge logic needed. If the user wants to merge content into an existing prompt, they copy manually.

---

## SDK

**Q: Does the SDK do Jinja2 rendering client-side?**
No. The SDK calls `POST /prompts/:name/:alias/render` with a variables JSON body and receives the already-rendered OpenAI-compatible messages array. The SDK is intentionally thin — no nunjucks dependency, no template parsing.

**Q: Node.js only or browser-compatible?**
Node.js only. LLM calls happen server-side; no browser SDK needed in Phase 1.

**Q: How is the SDK initialized?**
Constructor takes priority, env vars as fallback — `new AgenticHub({ apiKey, baseUrl, maxCacheSize, cacheTtl })`. Env vars: `AGENTICHUB_API_KEY`, `AGENTICHUB_BASE_URL`. Same pattern as OpenAI/Anthropic SDKs.

**Q: What's the SDK caching strategy?**
`lru-cache` (npm), module-level singleton shared across all SDK instances in the same process. Stale-while-revalidate: serve cached value immediately, trigger background refresh. If API is unreachable and a stale entry exists, serve stale silently and log a warning. Revisit this behavior later.

**Q: Why `lru-cache` instead of a plain Map?**
A plain Map grows unbounded — with 500 prompts all cached indefinitely, memory balloons. `lru-cache` evicts least-recently-used entries at capacity and has native TTL support, eliminating manual timestamp logic.

**Q: What are the cache defaults and are they configurable?**
Default TTL: 60 seconds (short enough that a promoted alias is live within a minute). Default max size: 500 entries. Both configurable via constructor: `new AgenticHub({ cacheTtl: 60, maxCacheSize: 500 })`.

**Q: What happens on a cold cache with API unreachable?**
No stale value exists — the SDK must throw. Stale-silent fallback only applies when a prior cached value exists.

**Q: Does the SDK retry on transient failures?**
Yes — retry behavior is configurable via constructor: `maxRetries` (default: 1) and `retryInterval` in ms (default: 500ms). One retry absorbs momentary blips without slowing LLM calls noticeably. After exhausting retries, the SDK throws (or serves stale if available).

---

## Tech Stack Decisions (confirmed 2026-06-22)

**Q: Which ORM / DB library?**
Prisma ORM with the official Prisma Client. Decision reversed from Drizzle (2026-06-23): Prisma's schema ergonomics, migration tooling (`prisma migrate dev`), and developer familiarity outweigh Drizzle's TypeScript-native schema advantage for this project. The Prisma schema DSL is clean and readable; `prisma.$queryRaw` covers the RLS raw-SQL use case.

**Q: Where does the DB schema live?**
All Prisma model definitions in `prisma/schema.prisma` (at `apps/api/prisma/schema.prisma`) — single source of truth. Migrations generated by `npx prisma migrate dev --name <description>` into `prisma/migrations/`. Never edit generated migration SQL by hand.

**Q: What is the package manager?**
npm (with npm workspaces). Decision changed from pnpm (2026-06-23): npm workspaces are sufficient for this monorepo and have lower friction — fewer tool compatibility issues, no hoisting surprises, universally understood. Turborepo handles task orchestration regardless of package manager.

**Q: Should `users` have a display name / username field?**
Add `display_name TEXT` (nullable). Not a login credential — email stays the identifier. `display_name` appears in audit logs and team member lists. Named `display_name` (not `username`) to avoid implying uniqueness or handle semantics.

**Q: Should roles use a Postgres ENUM?**
Yes — `CREATE TYPE team_role AS ENUM ('owner', 'admin', 'editor', 'viewer')`. Used everywhere roles appear: `team_member_roles.role`, `team_invites.roles team_role[]`. Adding a role later requires `ALTER TYPE … ADD VALUE` (one DDL line, no data migration).

**Q: Should `audit_log.event` be a Postgres ENUM?**
Yes — `CREATE TYPE audit_event AS ENUM ('prompt_created', 'prompt_renamed', 'prompt_deleted', 'version_committed', 'alias_promoted', 'api_key_generated', 'api_key_revoked', 'member_invited', 'member_role_updated', 'member_removed')`. A separate code→description mapping table is over-engineered; the enum values are the codes.

**Q: Should `prompt_aliases.alias` be an ENUM?**
No — keep `TEXT`. Phase 1 only auto-creates `production` and `staging`, but custom aliases are not prohibited in future phases. `ALTER TYPE … ADD VALUE` per new alias is more friction than it's worth; app-layer validation (`^[a-z][a-z0-9-]{0,63}$`) is sufficient.

**Q: What is the testing approach?**
Integration tests only — no dummy tests, no mocks, no stubs for the DB layer. Every test exercises the full HTTP → service → repository → real Postgres stack using `supertest` against the actual Express app and a real test database (`TEST_DATABASE_URL`). Tests are self-contained (each creates its own data via the API) and test full data flows (e.g. create prompt → commit version → promote → render returns new content), not individual functions. External HTTP calls to paid APIs (e.g. LiteLLM in Phase 2) are the only acceptable mock target.

**Q: What is the project folder structure?**
Domain-first modular structure. Each domain folder (`auth/`, `prompts/`, `versions/`, etc.) contains: `<domain>.router.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `<domain>.repository.ts`, `<domain>.types.ts`, `<domain>.test.ts`. Shared infrastructure lives in `src/shared/` (db client, error classes, middleware). Full canonical structure is in `CLAUDE.md`.

---

## Bootstrap & Dev Environment (confirmed 2026-06-23)

**Q: Where do `app.ts` / `server.ts` live, and what does the `dev` script point to?**
At the `apps/api` root (not under `src/`), per the canonical layout in `CLAUDE.md`. The `dev` script is `tsx watch server.ts`. Why: the script previously pointed at `src/server.ts`, which does not exist, so `npm run dev` crashed with `ERR_MODULE_NOT_FOUND`. The file location is correct; the script path was the bug.

**Q: Does Phase 1 use a separate test database?**
No. Phase 1 dev uses a **single** database (`agentichub`). Why: during the build phase a dedicated test DB adds friction with no payoff yet, and pointing tests at the dev DB would truncate dev data. This *refines* (does not reverse) the "testing approach" decision above — the integration-test philosophy (real HTTP → repository → real Postgres, no mocks) still stands; provisioning a dedicated test database is deferred to when the test suite is wired. `TEST_DATABASE_URL` was removed from `.env` / `.env.example`.

**Q: How is the database bootstrapped for a fresh clone?**
`npm run db:setup` (`scripts/db-setup.ts`). It assumes a **running** Postgres (the Docker `postgres:18-alpine` container in the README — it does not start Postgres), connects to a maintenance DB via `PG_ROOT_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`), runs `CREATE DATABASE agentichub` if absent, then `prisma migrate deploy`. Why: idempotent, single-command, matches the README's documented intent, and works on a clone with no database yet. The orphaned `@embedded-postgres/linux-x64` dependency (referenced by nothing) was removed rather than wired up — the project already runs Docker Postgres.

**Q: How was Prisma Migrate adopted on a database that had been created with `db push`?**
The initial migration `prisma/migrations/0_init` was generated with `prisma migrate diff --from-empty --to-schema-datamodel`, then the existing dev DB was baselined with `prisma migrate resolve --applied 0_init` (records the migration as applied without re-running it, so no data loss). Why: aligns with `CLAUDE.md`'s "migrations managed by Prisma Migrate, not `db push`" rule while preserving the already-populated dev database. Fresh clones run `0_init` normally; verified by applying it from empty to a throwaway database.
