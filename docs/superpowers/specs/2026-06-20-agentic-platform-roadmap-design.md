# Agentic Platform — Phased Roadmap & Feasibility Brief

- **Date:** 2026-06-20
- **Status:** Master roadmap (approved for documentation). Each phase will get its own brainstorm → spec → plan before it is built.
- **Type:** Decomposition / roadmap. This is intentionally a *charter-level* document — enough to see the whole journey and the dependencies between phases, not a detailed implementation spec for any single phase.

---

## 1. North Star

Build a **multi-tenant agentic platform** that absorbs the feature set of the whole LLM-tooling category — prompt management, an AI gateway, observability, tool/agent support, and evaluation — unified behind **one data lineage**:

> **prompt version → request (through the gateway) → trace (with tool spans) → cost → eval result → agent run.**

Every incumbent owns one or two links in that chain. The bet — and the moat — is that **the integration of the whole chain** is more valuable than being the best at any single link, and that no incumbent stitches the seams cleanly.

The platform is built **layer by layer**: each phase ships standalone value **and** is a prerequisite for the next. The end state is an agentic platform where a prompt is a node, the gateway is the execution/control plane, traces are agent runs, the tool catalog defines capabilities, and eval is the quality loop.

---

## 2. Feasibility Verdict

- **Technical risk: low.** None of this is novel engineering. Phase 1 is well-trodden CRUD + auth + versioning. The hard, ops-heavy parts (a proxy in the production request path, trace storage at scale, evaluation, agent orchestration) are deliberately pushed to later phases and largely solvable by *wrapping* mature open-source tools (e.g. LiteLLM) rather than rebuilding them.
- **Business risk: real, and concentrated in differentiation.** This is a crowded category. A prompt-management-only product is **not** a moat. Feasibility as a *business* depends on (a) phasing to avoid building four products at once, and (b) executing the integration story above. The phased plan in this document is what converts an over-scoped idea into a feasible one.
- **Conclusion:** Feasible **because it is phased**. The job of the early phases is not to win on any single feature, but to earn adoption cheaply and build the data model that makes the integrated agentic story inevitable.

---

## 3. Strategic Positioning

- **Market:** Crowded. Direct/partial competitors per layer are listed in each phase below. Assume every individual feature already exists somewhere, often for free.
- **Wedge:** The **integration**, not any single pillar. Phase 1 is an *adoption wedge* (low-stakes, fast to validate), not the moat.
- **Distribution / GTM:** **Deferred** (decision postponed by choice). To avoid foreclosing the most proven distribution path in this category (open-source, bottom-up adoption → convert to cloud/enterprise), the architecture stays **open-core-friendly**: self-hostable, standard Postgres, no hard dependency on proprietary cloud-only services. Going open-core later becomes a licensing + packaging decision, not a rewrite.

---

## 4. Foundational Decisions (cross-cutting, apply to every phase)

These were settled during brainstorming and form the baseline for all phases.

### 4.1 Tenancy & isolation
- **Team is the top-level unit** (tenant **and** billing boundary) for now. A team has members and owns resources (prompts, keys, tools, traces).
- **Organization is deferred** — it will be added later as an *additive parent* above teams.
- **Hard rule to keep the org migration cheap:** *nothing* (prompt, member, key, tool, trace) may exist without a `team_id`. Adding org later is then "insert a parent table + FK," not a restructure.
- **Known future cost:** moving the **billing** boundary from team → org once real money flows is the expensive part of that migration. Earmarked.
- **Isolation model:** **shared schema, single Postgres, every row carries `team_id`, enforced with Postgres Row-Level Security (RLS).** Standard, cheap, and secure for B2B SaaS. Schema-/DB-per-tenant is reserved for a possible future enterprise/VPC tier only.

### 4.2 Roles (RBAC)
- Team-level roles: **Owner / Editor / Viewer**, plus a **"promote to production"** right (move env aliases).
- Per-prompt / per-resource ACLs are **out** until a real customer needs them (avoid over-engineering).

### 4.3 Tech stack
- **Database: Postgres — high conviction.** Rationale: multi-tenant RBAC is inherently relational (users, teams, memberships, roles, resources, versions, aliases = joins + FKs); **RLS** gives tenant isolation at the DB layer; cost/usage analytics later is SQL-native (and can grow into partitioning / TimescaleDB / a columnar store for traces); **JSONB** covers all flexible/document-shaped payloads (prompt content, message arrays, tool schemas, trace blobs) *inside* Postgres. MongoDB would fight us on the relational RBAC, the isolation story, and the analytics. **Recommendation: Postgres, with JSONB for flexible payloads.**
- **Frontend: React** (as preferred).
- **Backend: Express / TypeScript** (as preferred) — endorsed for Phase 1, which is pure CRUD and benefits from end-to-end types shared with React. **Honest caveat:** Phases 2 / 5 / 6 lean on a Python-first AI ecosystem (LiteLLM, tokenizers, eval libraries). Expect to either wrap those as services or run a small **Python sidecar** when those phases arrive. This is a normal polyglot split, not a reason to switch the core API language now.

### 4.4 Prompt model (set in Phase 1, reused later)
- **Immutable, numbered versions** + **movable environment aliases** (`production`, `staging`, …). Promotion/rollback = move an alias; no code deploy.
- **Consumption: both** — **runtime fetch via SDK (primary)** and **export/pull** (a thin convenience over the same fetch API). Runtime fetch is what makes the platform load-bearing infrastructure.
- The same immutable-version + alias model is **reused for the Tool Catalog** (Phase 4).

---

## 5. Phased Roadmap

> Sequence: **P1 Prompts → P2 Gateway → P3 Tracing → P4 Tool Observability & Catalog → P5 Evaluation → P6 Agentic Platform**, with **Enterprise & Platform** as a cross-cutting track pulled in as monetization demands.
>
> The ordering follows a **data flywheel**: the gateway (P2) makes traffic flow through us, which produces traces and cost data (P3) almost for free, which tool observability (P4) enriches, which evaluation (P5) turns into a quality loop, which the agentic platform (P6) orchestrates.

### Phase 1 — Prompt Management *(adoption wedge / foundation)*
- **Goal:** Become the source of truth for prompts and decouple prompt changes from code deploys.
- **In scope:** auth; **Teams** + membership; team RBAC (Owner/Editor/Viewer + promote right); prompt CRUD with variables/templating; **immutable versions + env aliases**; **text diff** between any two versions; **runtime SDK** (fetch by name + alias/version, with client-side caching for reliability) + **export/pull**; audit trail of who-changed-what.
- **Out of scope:** anything that calls an LLM (no playground/output comparison), proxy/keys, traces, eval, org layer.
- **Absorbs features of:** PromptLayer, Langfuse Prompts, Agenta, Vellum (prompt mgmt).
- **Dependencies:** none (foundation).
- **Build vs buy:** build (it's the foundation and the data model everything reuses).
- **Primary risks:** not a moat on its own — must be cheap to adopt and fast to validate; SDK reliability (caching/fallback) is the one place to be rigorous.
- **Definition of done / success signal:** a design partner fetches a production prompt at runtime via the SDK and ships a prompt change **without** a code deploy.

### Phase 2 — AI Gateway / Proxy
- **Goal:** Become the control plane for LLM traffic; enable cost control and unlock everything downstream.
- **In scope:** **BYOK** (teams bring provider keys); **virtual/proxy keys** generated per team/key with scopes; **budgets + rate limits** per key; provider **fallback / retries / load-balancing**; response **caching**; **cost-per-key / per-team tracking**. Unlocks the **output-comparison playground** (run an input through 2+ versions/models side by side), since a unified call layer now exists.
- **Out of scope:** full trace UI (that's P3), eval, agent orchestration.
- **Absorbs features of:** LiteLLM, Portkey, Helicone, OpenRouter, Cloudflare AI Gateway.
- **Dependencies:** P1 (keys/prompts are team-scoped; a gateway call can reference a prompt version).
- **Build vs buy:** **wrap/embed LiteLLM (or equivalent)** — do **not** rebuild a provider-abstraction layer. Likely the first place a **Python sidecar** appears.
- **Primary risks:** **operational — you are now in the production critical path.** Uptime, latency, and secret handling (BYOK storage/encryption) become first-class concerns. This is the phase that changes the company's operational maturity bar.
- **Definition of done / success signal:** a team routes real traffic through a generated proxy key, sees accurate per-key cost, and a budget cap actually halts spend.

### Phase 3 — Observability / Tracing
- **Goal:** Turn the traffic flowing through the gateway into debuggable, analyzable history.
- **In scope:** trace + span logging; **sessions**; dashboards (latency / tokens / cost over time); search & filter; **trace → exact prompt version lineage** (the integration moat made visible); user-feedback capture hooks.
- **Out of scope:** tool-specific views (P4), automated scoring/eval (P5).
- **Absorbs features of:** LangSmith, Langfuse, Helicone, Arize Phoenix.
- **Dependencies:** P2 (traffic through the gateway produces traces + cost largely "for free"); SDK can also report traces for non-gateway calls.
- **Build vs buy:** build the ingestion/UI; storage starts in Postgres (partitioning) with a planned path to a columnar/time-series store (e.g. ClickHouse / Timescale) if/when volume demands.
- **Primary risks:** **storage cost and scale** of high-volume trace data; query performance on large trace tables.
- **Definition of done / success signal:** a user opens a trace, sees the full request, and clicks through to the exact prompt version that produced it.

### Phase 4 — Tool Observability & Tool Catalog
- **Goal:** First-class support for tools/function-calling — **observability and definition, NOT execution.** *(Explicit product decision: the platform does not host, sandbox, or execute customer tools; tools run on the customer side.)*
- **In scope:**
  - **Tool Catalog** — a standalone, **versioned** registry of tool/function **schemas** (name, description, JSON-schema parameters). Reuses the Phase-1 **immutable-version + alias** model. Team-scoped. This is "prompt management, but for tool definitions."
  - **Waterfall trace view** — the span timeline (LLM call → tool call → tool result → next LLM call → nested agent steps), with latency bars, per-span inputs/outputs, and errors.
  - **Descriptions in the waterfall** — each span shows the relevant description: **prompt description** for prompt/LLM spans and **tool description** for tool spans, each **linked back to its catalog entry/version**.
  - Tool-call analytics: frequency, latency, error rates, cost attribution by tool.
- **Out of scope (explicit):** hosting/executing tools, sandboxing, any tool runtime.
- **Absorbs features of:** the tool/observability views of LangSmith, Langfuse, Phoenix — minus execution.
- **Dependencies:** P3 (waterfall is an enriched trace view); P1 model (catalog versioning).
- **Build vs buy:** build (it reuses P1 + P3 primitives).
- **Primary risks:** keeping the catalog in sync with what actually appears in traces (link, don't duplicate); waterfall UX performance on deep/nested traces.
- **Definition of done / success signal:** a user views a waterfall trace where each LLM span shows its prompt description and each tool span shows its tool description, both linking to the versioned catalog/registry entry.

### Phase 5 — Evaluation & Experimentation
- **Goal:** Close the quality loop — measure, compare, and regression-test prompts (and later, agents).
- **In scope:** **datasets** of test cases; **offline experiments** (run prompt versions across a dataset); **LLM-as-judge** scoring; **human annotation / labeling** queues; **regression testing** across versions; **online eval** on live traces; **production A/B testing** (env aliases + gateway + traces combined). Matures the playground from "eyeball" to "scored."
- **Out of scope:** agent orchestration (P6).
- **Absorbs features of:** Braintrust, Humanloop (eval), Patronus, Langfuse eval.
- **Dependencies:** P1 (versions), P2 (run executions), P3/P4 (traces + tool spans to evaluate).
- **Build vs buy:** wrap mature eval/scoring libraries where possible (Python sidecar territory).
- **Primary risks:** **scope creep** — evaluation is itself a large category; resist building everything. Pick the highest-value eval primitives first (regression on prompt versions, LLM-as-judge, human labeling).
- **Definition of done / success signal:** a user runs a new prompt version against a dataset, gets a score, and sees a regression flagged versus the production version.

### Phase 6 — Agentic Platform *(north star)*
- **Goal:** Orchestrate prompts, tools, gateway, traces, and eval into agents and multi-agent workflows.
- **In scope:** agent / workflow builder; multi-agent orchestration; **memory & state**; **RAG / knowledge bases**; human-in-the-loop; **guardrails / safety**; agent deployment/management; agent **simulation & evaluation** (reusing P5).
- **Out of scope:** re-inventing any P1–P5 primitive — agents must **reuse** prompts (as nodes), the gateway (as execution), the tool catalog (as capabilities), traces (as runs), and eval (as quality).
- **Absorbs features of:** LangGraph (Platform), CrewAI, AutoGen, Dify, Flowise, LangFlow, Vellum agents.
- **Dependencies:** all prior phases.
- **Build vs buy:** build the orchestration/definition + reuse-everything layer; wrap agent frameworks where sensible.
- **Open architectural fork (to resolve in Phase 6's own brainstorm):** **because tools are not hosted (Phase 4 decision), the execution model is likely client-side execution + report-back** — the customer's environment (via SDK / callbacks) runs the agent and its tools and streams traces back — rather than the platform's servers executing tools. Confirm during Phase 6 design.
- **Primary risks:** largest build by far; the temptation to re-implement instead of reuse; the execution-model fork above.
- **Definition of done / success signal:** a user composes a multi-step agent from existing prompts + cataloged tools, runs it, and sees the full agent run as a waterfall trace with eval scores.

### Cross-cutting — Enterprise & Platform *(pulled in as monetization demands)*
- **Scope:** the **Organization layer** above teams; **SSO / SAML**; advanced RBAC; **audit logs**; **billing / metering**; compliance (e.g. SOC 2); **self-host / OSS packaging**.
- **Notes:** the **org layer** and **billing boundary** are the items to introduce *before* deep dependencies accrete (see §4.1). SSO/audit/compliance are classic enterprise-tier gates and can lag until the first enterprise deal is in sight.

---

## 6. Key Cross-Phase Risks & Open Questions

1. **Differentiation (existential):** every single feature exists elsewhere. The moat is the integrated lineage — protect the seams between phases, not the features.
2. **Proxy operational risk (P2):** entering the production request path raises the bar on uptime, latency, and secret handling overnight.
3. **Trace storage scale (P3+):** plan the path off vanilla Postgres tables for high-volume traces before it hurts.
4. **Eval scope creep (P5):** a whole category; pick a few primitives.
5. **Phase-6 execution model:** client-side execution + report-back vs server-side — flagged, unresolved, decided in P6's brainstorm.
6. **GTM deferral (open-core vs proprietary):** deferred by choice; architecture hedges to keep it open. Decide before packaging/licensing work.
7. **Org/billing migration:** team→org parent is cheap if everything stays team-scoped; moving the *billing* boundary later is the expensive part.

---

## 7. Next Steps

- This document is the **master index**. It is **not** an implementation spec.
- **Each phase gets its own full brainstorm → spec → plan cycle** before any build, starting with **Phase 1 (Prompt Management)** when ready.
- No development begins from this document; it exists to align on scope, sequence, and the foundational decisions that every phase inherits.
