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

## Foundational decisions (see the roadmap for rationale)

- **Tenancy:** everything is `team`-scoped; shared schema + Postgres Row-Level
  Security. Organization is an additive parent to be introduced later.
- **Database:** PostgreSQL (JSONB for flexible payloads).
- **Frontend:** React. **Backend:** Express / TypeScript (a Python sidecar is
  expected for AI-heavy phases: gateway, eval, agents).
