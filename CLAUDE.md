# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

## Git workflow — non-negotiable rules

1. **Never commit directly to `main`.** `main` is protected by convention. All
   changes land via a **new branch + Pull Request**, never by committing on
   `main` locally or pushing to it directly.
2. **Always create a new branch** for any change. Use a descriptive name, e.g.
   `docs/...`, `feat/...`, `fix/...`, `chore/...`.
3. **Never commit without explicit permission.** Do not run `git commit` (or
   `git push`) until the user has clearly asked for it in the current request.
   Staging/preparing changes is fine; committing is not, until told.
4. **Open a Pull Request** for every change into `main`. Do not merge without
   the user's approval.

> If a task seems to require committing to `main` (for example, bootstrapping an
> empty repository that has no `main` yet), **stop and ask the user first** —
> do not assume an exception.

## Project overview

This repository is the home of an **agentic platform** (multi-tenant SaaS) being
built in phases. The master roadmap and all design specs live under:

- `docs/superpowers/specs/` — design briefs and phase specs.
  - Start with `docs/superpowers/specs/2026-06-20-agentic-platform-roadmap-design.md`
    (the phased roadmap and foundational decisions).

Each phase (Prompt Management → AI Gateway → Tracing → Tool Observability &
Catalog → Evaluation → Agentic Platform) gets its **own** brainstorm → spec →
plan cycle before any implementation begins.

## Decision logging — non-negotiable rule

Every technical decision made during any session (interview-me, brainstorming, spec writing, or ad-hoc conversation) **must be appended to the relevant FAQ file immediately** — not at the end of the session, not when asked, but as soon as the decision is confirmed.

- Phase 1 decisions → `docs/superpowers/specs/phase-1-faq.md`
- Future phases get their own FAQ file: `phase-2-faq.md`, etc.

Each entry must capture the **question** and the **why** (rationale), not just the what. A decision without a rationale is not a decision — it is a guess waiting to be re-litigated.

If a decision is reversed or refined, **update the existing FAQ entry** rather than appending a conflicting one.

## Open questions — non-negotiable rule

Sometimes the user raises a design tension but explicitly asks to **defer it and
reconsider at the end of the phase** rather than decide now. The moment such a
question is parked, **append it to `docs/superpowers/specs/open_questions.md`
immediately** — do not rely on remembering it later.

- This file is distinct from the FAQ: the FAQ records decisions that **are
  made** (question + why); `open_questions.md` records decisions **deliberately
  postponed** (question + current behaviour + what to decide at phase end).
- When an open question is resolved, move it into the relevant `phase-N-faq.md`
  as a normal decision-with-rationale and strike the `open_questions.md` entry
  with a pointer to the FAQ — preserve the history, don't silently delete it.

## Foundational decisions (see the roadmap for rationale)

- **Tenancy:** everything is `team`-scoped; shared schema + Postgres Row-Level
  Security. Organization is an additive parent to be introduced later.
- **Database:** PostgreSQL (JSONB for flexible payloads). **ORM: Prisma** with the official Prisma Client.
- **Frontend:** React. **Backend:** Express / TypeScript. **No Python in Phase 1** — nunjucks handles Jinja2 templating in Node.js. Python sidecars are anticipated for Phase 2 (LiteLLM gateway), Phase 5 (eval/scoring libraries), and Phase 6 (agent orchestration); they live in `services/` when they arrive and are called over HTTP from the core API.

---

## Code best practices — non-negotiable rules

### Language & style

- **TypeScript everywhere.** All source files are `.ts` or `.tsx`. No plain `.js` files in `src/`.
- Strict mode on: `"strict": true` in `tsconfig.json`. No `any` unless the type is genuinely unknowable and a comment explains why.
- Use `interface` for object shapes exposed in public APIs; `type` for unions, intersections, and internal aliases.

### Repository layout (monorepo)

This is an **npm workspaces monorepo** with Turborepo for task orchestration. The top-level structure maps directly to the 6-phase platform roadmap.

```
agenticprompthub/                        ← monorepo root
│
├── apps/
│   ├── api/                             ← Main Express/TypeScript API (phases 1–4+)
│   ├── web/                             ← React frontend (phase 1 F1–F5+)
│   └── worker/                          ← Async job runner (phase 5+: eval runs)
│
├── packages/
│   ├── sdk/                             ← @agentichub/sdk — TypeScript, Node only
│   └── types/                           ← Shared TS types (api ↔ sdk ↔ web)
│
└── services/                            ← Extracted when monolith needs splitting
    ├── gateway/                         ← Phase 2: Python/LiteLLM sidecar
    ├── telemetry/                       ← Phase 3: high-volume trace ingest
    └── eval/                            ← Phase 5: Python eval + scoring sidecar
```

`services/` folders start empty — the corresponding logic begins as a module inside `apps/api` and moves here only when it needs independent deployment or a different language runtime.

---

### `apps/api` domain structure

Group code by **domain, then by kind**. Domains that are sub-resources of another domain are nested inside it (e.g. `versions/` and `aliases/` live under `prompts/`).

```
apps/api/
├── src/
│   │
│   ├── auth/                    ← Phase 1
│   ├── teams/                   ← Phase 1
│   │   ├── members/
│   │   └── invites/
│   ├── prompts/                 ← Phase 1 — core versioning model (reused by tools/)
│   │   ├── versions/
│   │   ├── aliases/
│   │   └── diff/
│   ├── api-keys/                ← Phase 1
│   ├── audit/                   ← Phase 1
│   │
│   ├── gateway/                 ← Phase 2: AI proxy, virtual keys, budgets
│   │   ├── keys/
│   │   ├── budgets/
│   │   ├── providers/
│   │   └── cache/
│   │
│   ├── traces/                  ← Phase 3: ingestion + query
│   │   ├── spans/
│   │   └── sessions/
│   │
│   ├── tools/                   ← Phase 4: Tool Catalog (same model as prompts/)
│   │   ├── versions/
│   │   └── aliases/
│   │
│   ├── datasets/                ← Phase 5
│   ├── experiments/             ← Phase 5
│   ├── evaluations/             ← Phase 5
│   │
│   ├── agents/                  ← Phase 6
│   │   ├── workflows/
│   │   ├── memory/
│   │   └── knowledge/
│   │
│   ├── organizations/           ← Enterprise: org layer above teams
│   │
│   └── shared/
│       ├── db/
│       │   └── client.ts        ← single PrismaClient instance
│       ├── middleware/
│       │   ├── error.middleware.ts
│       │   └── validate.middleware.ts
│       └── errors/
│           ├── app-error.ts
│           └── http-errors.ts
│
├── prisma/
│   ├── schema.prisma            ← all model definitions (single source of truth)
│   └── migrations/              ← Prisma-generated SQL migrations
├── app.ts                       ← Express factory — mounts all routers, no listen()
└── server.ts                    ← Entry point — imports app.ts, calls listen()
```

**Domain file pattern** — every domain folder follows the same internal structure:

```
<domain>/
  <domain>.router.ts       ← Express router wiring only
  <domain>.controller.ts   ← HTTP in/out: validate → call service → respond
  <domain>.service.ts      ← Business logic / use-cases
  <domain>.repository.ts   ← All DB queries for this domain (imports db, nothing else does)
  <domain>.types.ts        ← Zod schemas, interfaces, DTOs
  <domain>.test.ts         ← Integration tests (real DB, no mocks)
```

Sub-domain folders (e.g. `prompts/versions/`) follow the same pattern independently.

- **One concern per file.** A service file must not contain route handlers. A repository file must not contain business logic.
- **One class or one cohesive set of related functions per file.** Do not bundle unrelated utilities into a single `helpers.ts` catch-all.
- All files in a folder must be re-exported via an `index.ts` barrel file.

### Classes vs. functions

- Prefer **classes** for stateful constructs: services, repositories, clients (DB, HTTP, cache).
- Prefer **plain functions** for stateless transformations and pure utilities.
- Do not use classes merely to namespace functions — use a module (file) for that.

### JSDoc on every exported symbol — non-negotiable

Every exported function, class, method, and type **must** have a JSDoc block with:

```ts
/**
 * One-line summary of what this does.
 *
 * @param paramName - What it is and any constraints (e.g. "must be > 0").
 * @returns What is returned and in which shape.
 * @throws {ErrorClassName} When and why this throws.
 */
```

- Private/internal helpers that are not exported may omit JSDoc, but must still have a one-line comment if the intent is non-obvious.
- Do not write JSDoc that merely restates the function name ("Gets the user" on `getUser`). Describe the *why* or the *edge cases*.

### Naming conventions

| Construct | Convention | Example |
|-----------|-----------|---------|
| Files | `kebab-case` | `prompt-service.ts` |
| Classes | `PascalCase` | `PromptService` |
| Interfaces / Types | `PascalCase` (no `I` prefix) | `CreatePromptDto` |
| Functions / methods | `camelCase` | `createPrompt()` |
| Constants | `UPPER_SNAKE_CASE` for module-level; `camelCase` for local | `MAX_VERSION`, `defaultLimit` |
| Enums | `PascalCase` with `PascalCase` members | `PromptStatus.Active` |

### Error handling

- Define domain-specific error classes in `src/shared/errors/` (e.g. `NotFoundError`, `ForbiddenError`).
- Services throw typed errors; controllers catch them and map to HTTP status codes.
- Never swallow errors silently. Always either re-throw or log and re-throw.

### Prisma ORM

- The single `PrismaClient` instance is created once in `src/shared/db/client.ts` and imported everywhere — never instantiate `PrismaClient` inside a service or repository.
- All model definitions live in `prisma/schema.prisma`. This is the single source of truth for table names, field types, and constraints. Do not duplicate model definitions anywhere else.
- All database access goes through **repository classes** (`<domain>.repository.ts`). Services must never import `prisma` directly — only repositories do.
- Migrations are managed by **Prisma Migrate**: `npx prisma migrate dev --name <description>` to create and apply in development; `npx prisma migrate deploy` in production. Never edit generated migration files by hand; create a new migration instead.
- Use Prisma's generated types (`Prisma.PromptGetPayload<...>`, `Prisma.PromptCreateInput`, etc.) as the source of truth for entity shapes in `*.types.ts` files.
- For complex queries not expressible via the Prisma query builder, use `prisma.$queryRaw` or `prisma.$executeRaw` with the tagged `Prisma.sql` template literal — do not stringify SQL manually.
- For Row-Level Security (RLS, deferred to post-Phase 1), the pattern will be: execute `SET LOCAL app.current_team_id = '${teamId}'` inside a `prisma.$transaction` before the query. Plan the connection pool accordingly when RLS arrives.

### Express (API framework)

- Mount all routers in `app.ts`; never call `app.use()` inside a domain router file.
- Route handlers (controllers) do exactly three things: validate the request, call a service method, send the response. No business logic in controllers.
- Use a single global error-handling middleware registered last in `app.ts` to convert typed errors to HTTP responses.
- Validate request bodies and query params with **Zod** schemas defined in `<domain>.types.ts`. Parse at the controller boundary; pass typed objects into services.
- All routes are prefixed with `/api/v1` at the router level.

### Testing

**Philosophy: real data flows only. No dummy tests, no mocks, no stubs.**

Every test exercises the full stack — HTTP request → controller → service → repository → real Postgres → response. If the database is not involved, the test is not valuable.

**Stack:**
- `supertest` — makes real HTTP requests against the Express app
- Real Postgres test database (`TEST_DATABASE_URL` env var, separate from dev DB)
- Tables truncated before each test suite (or per-test via `beforeEach`)
- No mocking of the DB layer, ever. No `jest.mock()` on repositories or services.

**What a test must do:**
1. **Arrange** — create all required data by calling the API (signup, create resources, etc.)
2. **Act** — perform the operation under test
3. **Assert** — check the HTTP response AND query the DB directly to verify state

**Example — real data flow test:**
```typescript
it('render returns updated content after production is promoted to a new version', async () => {
  // Arrange: real user, real team, real prompt
  const { apiKey } = await signupAndGetKey(app);

  const { body: prompt } = await request(app)
    .post('/api/v1/prompts')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name: 'greeting' })
    .expect(201);

  await request(app)
    .post(`/api/v1/prompts/${prompt.id}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
    .expect(201);

  await request(app)
    .post(`/api/v1/prompts/${prompt.id}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'system', content: 'Hi there, {{ name }}!' }] })
    .expect(201);

  await request(app)
    .post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ version_number: 2 })
    .expect(200);

  // Act
  const res = await request(app)
    .post(`/api/v1/prompts/greeting/production/render`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ variables: { name: 'Alice' } })
    .expect(200);

  // Assert — v2 content is live
  expect(res.body.messages[0].content).toBe('Hi there, Alice!');
});
```

**Rules:**
- Tests live next to the file they test (`<domain>.test.ts`), not in a top-level `tests/` folder.
- Each test is fully self-contained — it creates everything it needs. No shared fixtures that bleed between tests.
- Test the chain, not the unit: "create prompt → commit version → promote → render returns new content" is one test, not four.
- External HTTP calls (e.g. LiteLLM in Phase 2) are the only things that may be mocked — and only because they involve real network calls to paid APIs.

---

## API Reference (living doc) — non-negotiable rule

**Document an endpoint here ONLY after it is built AND verified working via curl.**

Never pre-document. Never document from the spec alone. The entry below is written the moment the curl command returns the expected response. If the response differs from the spec, fix the code first, then document what actually works.

**Entry format:**

```
### METHOD /api/v1/path

curl -X METHOD http://localhost:3000/api/v1/path \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '<exact request body that was tested>'

# Response (status NNN)
{
  <exact response body that was returned>
}
```

<!-- Endpoints are added below this line as they are built and curl-verified -->

### POST /api/v1/auth/signup

curl -c cookies.txt -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"password123","displayName":"Dev Tester"}'

# Response (status 201) — also sets a `connect.sid` HttpOnly session cookie
{
  "user": { "id": "0eaa4065-fcfa-40ae-8d7a-06b2554331b5", "email": "alice@example.com", "displayName": "Dev Tester" },
  "team": { "id": "40dbd116-e2c1-482c-b07e-14abca710162", "name": "alice@example.com's team" }
}

### GET /api/v1/auth/me

curl -b cookies.txt http://localhost:3000/api/v1/auth/me

# Response (status 200)
{
  "user": { "id": "0eaa4065-fcfa-40ae-8d7a-06b2554331b5", "email": "alice@example.com", "displayName": "Dev Tester" },
  "team": { "id": "40dbd116-e2c1-482c-b07e-14abca710162", "name": "alice@example.com's team" },
  "roles": ["owner"]
}

### POST /api/v1/api-keys

# Accepts EITHER a session cookie OR a Bearer key. Full `key` is returned only here.
curl -b cookies.txt -X POST http://localhost:3000/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"my-dev-key"}'

# Response (status 201)
{
  "id": "21ef4fd3-e386-4026-8470-2cbe7c650e06",
  "key": "58012951ebbf22406876ae7dd44618143edded27786239f682eae7dcabbf924a",
  "name": "my-dev-key",
  "createdAt": "2026-06-23T15:30:37.806Z"
}

### GET /api/v1/api-keys

# Session cookie OR Bearer key — both verified to return 200. Full key never returned (only lastFour).
curl -b cookies.txt http://localhost:3000/api/v1/api-keys
# or: curl -H "Authorization: Bearer <key>" http://localhost:3000/api/v1/api-keys

# Response (status 200)
[
  { "id": "21ef4fd3-e386-4026-8470-2cbe7c650e06", "name": "my-dev-key", "lastFour": "924a", "createdAt": "2026-06-23T15:30:37.806Z" }
]

### POST /api/v1/auth/login

curl -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"password123"}'

# Response (status 200) — sets a `connect.sid` session cookie. Same shape as signup.
{
  "user": { "id": "2774d97d-312a-467c-a370-fc5a6e490382", "email": "alice@example.com", "displayName": null },
  "team": { "id": "ca68151a-1ec4-43b9-b523-6472357181b2", "name": "alice@example.com's team" }
}

# Wrong email or password (status 401) — same message for both, no user enumeration:
# { "error": { "code": "UNAUTHORIZED", "message": "Invalid email or password." } }

### POST /api/v1/auth/logout

# Requires an active session cookie. Destroys the session server-side.
curl -b cookies.txt -X POST http://localhost:3000/api/v1/auth/logout

# Response (status 204) — no body. The session is now dead: a subsequent
# GET /auth/me with the same cookie returns 401 UNAUTHORIZED.
# Logout with no active session also returns 401 UNAUTHORIZED.

### DELETE /api/v1/api-keys/:id

# Soft-revokes the key (sets revoked_at); it immediately stops authenticating.
# Session cookie OR Bearer key. You can only revoke keys in your own team.
curl -b cookies.txt -X DELETE \
  http://localhost:3000/api/v1/api-keys/9d4a12f2-8a6a-4a5c-a1d5-708676196c1e

# Response (status 204) — no body. The id disappears from GET /api/v1/api-keys.

# Unknown id (or a key in another team) returns 404:
# { "error": { "code": "NOT_FOUND", "message": "API key not found." } }
