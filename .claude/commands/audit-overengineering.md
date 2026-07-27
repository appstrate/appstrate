---
description: Hunt machinery whose cost exceeds the evidence it earns — over-engineering and technical debt — via parallel opus sub-agents, then adversarially verify every candidate before reporting
---

# /audit-overengineering — Cost-vs-evidence audit

Finds code that **costs more than the evidence says it buys**, and proposes the simpler thing that already exists.

This is NOT a complexity audit. Complexity is not the defect — unjustified complexity is. A 200-line state machine guarding a real failure mode earns its keep; a 20-line convenience that widens a security surface does not. Every finding must carry the number that decides it.

## When to use

- Before a release, on a subsystem that has accumulated fixes
- After a large feature branch merges (machinery is cheapest to remove while it's fresh)
- When a reviewer says "this feels heavy" and you want the question settled with evidence
- Periodically, per subsystem — never as a blanket "clean the codebase" pass

## The one rule that keeps this safe

**A guard is innocent until proven redundant.** The failure mode of this audit is producing a plausible kill list that removes protections nobody remembered the reason for. Every candidate goes through an adversarial pass whose job is to SAVE it. Only what survives a genuine attempt at justification is reported.

Corollary: a finding without a **named simpler replacement** is not a finding. "Delete this" is not actionable; "delete this, `getRun` already returns the same bytes" is.

---

## Pattern catalogue

Each pattern has a **tell** (how to find it) and a **decider** (the fact that settles it). Hunt the tell; report only when the decider lands.

### P1 — Capability threading

A decision made where it is cheap to make, transported to where it is not.

- **Tell**: a field whose only job is to carry a boolean/enum across ≥3 layers; `state`/claim/token payloads that gained a member; `...(x ? {x:true} : {})` spread chains.
- **Decider**: is the transport _intrinsic_? If the decision point is authenticated and the action point is not (stateless callback, webhook, background worker), any version of the feature must thread it — so judge **the feature**, not the plumbing. Refactoring cannot help.
- **Ask**: what does the feature buy? If the answer is "one saved API call", weigh it against the transport plus the surface it opens.

### P2 — Duplicated durability

New storage for data that is already persisted and already reachable.

- **Tell**: a write path that serialises something already in a table/blob; a new "pointer" abstraction.
- **Decider**: does an existing operation return the same bytes? Grep the OpenAPI `operationId`s and the schema columns before accepting any new store.

### P3 — Automating around a mistake an explicit error already covers

- **Tell**: repair/normalise/coerce logic on input a caller "should" have got right; comments saying "instead of refusing".
- **Decider**: did the **same branch** also add the instruction, doc, or prompt that prevents the mistake? Then the automation is redundant with its own sibling fix. Check the diff, not the file.

### P4 — Convenience that widens a surface

- **Tell**: the code often confesses. Grep for `ACCEPTED TRADE-OFF`, `blast radius`, `deliberately widens`, `now possible`, `prompt injection`, `best-effort by design`.
- **Decider**: state what an attacker (or a confused model) can newly cause. If the convenience is "the caller does not have to write one field", the trade is almost never worth it.

### P5 — The guard that would not have fired

- **Tell**: a threshold constant (bytes, ms, count) introduced with an incident as justification.
- **Decider**: compare the threshold to the **measured** magnitude in that incident. Plans under `claudedocs/` and PR bodies frequently record this outright — search them for "would not have", "n'aurait rien changé", "not claimed to be that fix".
- **Nuance**: a guard that did not fire may still bound a genuinely unbounded surface. Then keep the guard and attack its _implementation_ (see P2), not its existence.

### P6 — Complexity begetting complexity

- **Tell**: `git log` pairs — a feature commit followed by a commit hardening that same feature. `git log --grep="fix(security)"` then ask what each one hardened.
- **Decider**: if the hardening exists only because the feature exists, removing the feature removes the whole class rather than the one instance.

### P7 — Speculative generality

- **Tell**: an interface with exactly one implementation; a registry with one entry; an options object where every call site passes the same value; an env var never set to anything but its default.
- **Decider**: **one adapter is a hypothetical seam, two is a real one.** Count real call sites, not imagined ones. (See the `codebase-design` skill for the deep-module vocabulary.)

### P8 — Dead compatibility shims

- **Tell**: backfills, migrations shims, `legacy`/`deprecated`/`v1` branches, dual-read paths.
- **⚠️ REPO-SPECIFIC TRAP**: **production exists and holds real data.** "This repo has no production data" was true only on one 2026 refactor sweep and is now false. Before removing any shim, classify it:
  - **SAFE** — served a migration already applied everywhere, no persisted artifact depends on it
  - **PROD-DATA** — rows written in the old shape still exist → keep, or write a migration first
  - **PUBLISHED-CONTRACT** — an npm release, an AFPS manifest, or a stored package ZIP depends on it → keep; removing it is a breaking change with a release lockstep

Report the classification for every shim examined. An unclassified shim is not a finding.

---

## What earns its keep (the counter-checklist)

Run this against every candidate before reporting it. Any YES is a strong keep signal:

- **Measured incident** — a run id, a cost, a ticket, a log line. Evidence beats intuition in both directions.
- **User-visible failure prevented** — a dead-end UI, a silent truncation, a lost deliverable.
- **Unbounded surface bounded** — even if it never fired, is the input attacker-shaped or size-unbounded?
- **Permission/role case** — does the "simpler" alternative quietly require a right the actor may not hold? A convenience removal that blocks a lower-privileged role is a regression, not a simplification.
- **DRY across ≥2 real consumers** — an extraction serving two engines/paths is not over-engineering.

Report the keeps too, briefly, with their reason. An audit that only produces cuts has not been honest about what it examined.

---

## Execution

### Scoping (do this first)

Whole-codebase in one pass is neither useful nor affordable. Ask the user to pick, or infer from their request:

1. **Subsystem** — e.g. `packages/module-chat`, `apps/api/src/services`, `packages/afps-runtime`
2. **Recent branch/release** — `git diff <base>...HEAD`, the highest-yield mode (machinery is cheapest to remove while fresh)
3. **Full sweep** — only on explicit request; state the agent count before launching

Then record the starting state: `git status`, `git log --oneline -5`.

### Phase 1 — Hunt (parallel, read-only)

Dispatch opus sub-agents IN PARALLEL (one message, N tool_uses), one per **pattern group**, each scoped to the chosen area:

| Agent | Patterns                                                    |
| ----- | ----------------------------------------------------------- |
| A     | P1 capability threading, P4 surface widening                |
| B     | P2 duplicated durability, P7 speculative generality         |
| C     | P3 redundant automation, P5 guards that would not fire      |
| D     | P6 complexity chains (git-log archaeology), P8 compat shims |

Every hunter must:

- Read `CLAUDE.md` for the subsystem's stated invariants before judging anything
- Search `claudedocs/`, PR bodies (`gh pr view`), and commit messages for the **original justification** — the strongest findings come from authors who already admitted the limit in writing
- Return candidates with `file:line`, the **cost** (lines / files / new surfaces), the **claimed benefit**, and the **evidence found or missing**
- Never edit. Never conclude. Candidates only.

### Phase 2 — Adversarially verify (parallel, per candidate)

For each candidate, spawn a verifier whose brief is **to save the code**:

> Argue this code earns its place. Find the incident, the failure mode, the role case, the unbounded input it bounds. Run the counter-checklist. Default to KEEP if you find any real justification. Only concede REMOVE if you can also name the specific existing mechanism that already covers it.

A candidate is reported only if the verifier concedes AND names the replacement. This mirrors the discipline that made the manual version of this audit trustworthy: three of its own claims were falsified at this stage and dropped.

### Phase 3 — Report

Rank by `(surface removed × risk removed) / effort`. For each finding:

```
### <N>. <name> — <prod lines> / <files> / <new surfaces>

**Costs**: <lines, files, transported state, storage, security surface>
**Buys**: <the claimed benefit, in one line>
**Already covered by**: <the named existing mechanism — REQUIRED>
**Evidence**: <the number that decides it, quoted from plan/PR/log/measurement>
**Breaks if removed**: <honest consequence, including role/permission cases>
**Verdict**: remove | keep-guard-simplify-implementation | keep
```

Then a short **Examined and kept** section — what was looked at and why it stays.

Close with the intrinsic/accidental call for each removal: _intrinsic_ means the whole feature goes, _accidental_ means refactor in place.

### Phase 4 — Hand back

Report and stop. Do NOT start removing. Ask which findings to act on — removals are judgement calls about product behaviour, and a removal that changes a user-visible path (an error the user now sees, a step they now take) must be flagged as a **behaviour change**, not sold as pure cleanup.

---

## Worked example (real, from PR #982)

The finding that defines the shape:

> **Auto-activation on connect** — 278 prod lines / 8 files / +1 signed token claim.
> **Buys**: one saved API call for an admin.
> **Already covered by**: `activateIntegration`, already in the MCP operation surface; the platform's own RBAC decides who may call it.
> **Evidence**: env-backed SYSTEM integrations were already active without an install row, so it only ever reached org-installed ones. It shipped with a privilege escalation (`integrations:connect` is a member right; install is admin-only).
> **Breaks if removed**: the user sees a 412 once and clicks Activer. The obvious alternative — refuse the connection until active — is NOT viable: it would block member self-connect until an admin acted first.
> **Verdict**: remove — **intrinsic**. The decision point is authenticated, the action point (OAuth callback, hosted portal) is not, so any auto-activation must thread the capability, and re-deriving it there _was_ the escalation.

Note what makes it actionable: a named replacement, a number, an alternative considered and rejected on a role case, and an intrinsic/accidental call.
