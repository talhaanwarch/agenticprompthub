# Open Questions — to revisit at the end of the relevant phase

These are questions raised mid-build that we **deliberately parked** rather than
decided. They are not bugs and not blockers — they are design tensions to
re-examine once the phase is functionally complete and we can judge them against
real usage.

- Each entry records the **question**, the **current behaviour** (what the code
  does today), and **what to decide** at phase end.
- When a question is resolved, move the resolution into the relevant FAQ
  (`phase-N-faq.md`) as a normal decision-with-rationale, and strike the entry
  here (`~~...~~`) with a pointer to the FAQ — don't just delete it, so the
  history of "we thought about this" survives.

---

## Phase 1

### Q1 — Should a solo user ever see the "team" concept, and what should the auto-created team be named?

**Raised:** 2026-06-23

**Current behaviour:**
On signup, a team is auto-created and the user is added as its `owner`. The team
is the tenancy boundary — `prompts`, `api_keys`, and `audit_log` are all
`team_id`-scoped, so a user cannot exist without one. The auto-generated team
name is `"<email>'s team"` (e.g. `"alice@example.com's team"`). The join path
for additional members (shareable invite links) is specced in **B6 (Teams +
RBAC)** but not yet built.

**Why it's parked, not changed:**
The model is already solo-first — every user gets their own team-of-one, which is
exactly the "every user has its own team" behaviour we want, and it avoids an
empty-state dead-end (nowhere to put a prompt/key before a team exists). The only
clearly weak part is cosmetic: the email-derived team name.

**What to decide at phase end:**
1. **Team name** — keep `"<email>'s team"` and add a `PATCH /teams/:id` rename
   (recommended, cosmetic-only), or derive a nicer default from `display_name`
   (`"Alice's workspace"`, falling back to email when null)?
2. **Visibility** — once B6 invites exist and dogfooding is real, is the "team"
   concept the right thing to surface to a solo user, or should the UI hide it
   until a second member is added?
