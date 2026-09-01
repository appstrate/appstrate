---
description: Exhaustive transitional-code audit — dispatches parallel opus sub-agents to find every compatibility branch, data-repair-in-a-drizzle-migration, and dead transition shim that docs/NO_TRANSITIONAL_CODE.md forbids
---

# /audit-legacy — Transitional & legacy code audit

100%-coverage audit of the rule in `docs/NO_TRANSITIONAL_CODE.md`: the codebase
describes how the system works **now**, never how it used to, and never carries a
bridge between the two. Dispatches opus sub-agents in parallel, each sweeping one
dimension, and consolidates into one report written to
`claudedocs/audit-legacy-<YYYY-MM-DD>.md`.

## When to use

- Before a release
- After any rename or refactor that spans a schema and its data
- After completing a migration or retiring a feature flag — the transition is
  over, so its scaffolding must be gone
- Periodically, as a debt health-check

## What it checks

`docs/NO_TRANSITIONAL_CODE.md` is authoritative. Four prohibitions:

1. **No backward-compatibility branches** — a validator/parser/resolver accepts
   exactly one form. No legacy aliases, `X ?? legacyX` fallbacks, dual-read
   paths, "accept both shapes" parsing, regex alternations admitting a retired
   spelling. A retired name must never quietly work — it either fails loudly, or
   (better, where a tool sits in the path) is rewritten by that tool so the
   platform never learns it.
2. **Data repair belongs in `scripts/migration/`, never in a drizzle migration**
   — `packages/db/drizzle/*.sql` describes schema and is replayed forever. DML
   that rewrites row contents is an operational task. Two overlaps are
   legitimate, both an `UPDATE` landing on the **same table** as the clause
   licensing it: a backfill preconditioning a `SET NOT NULL` promotion, a
   `CHECK`, or a `VALIDATE CONSTRAINT`; and a fold whose source column the same
   file `DROP`s. A `CHECK` added `NOT VALID` enforces nothing and licences
   nothing. §2 of the doc states all of it in full, with its limits, and is the
   authority — do not audit from this summary.
3. **No dead transition scaffolding** — decided feature flags, shims, adapters
   wrapping a shape nothing emits, `@deprecated` exports with no caller,
   re-export barrels that exist only to keep an old import path resolving.
4. **No retirement guard outlives its transition** — the guard §1 creates is
   itself transitional code: it exists only because of a transition and is
   invisible on a fresh install. It is DELETED, not dated. An expiry annotation
   was considered and rejected — it keeps the code, the prose and the tests, and
   pays the full reader cost to defer the decision. Two limits §4 states and
   this summary cannot: deleting a guard may make an old form SILENT (relocate
   the work to the tool in the path, do not keep the guard), and a guard that is
   load-bearing for data that works TODAY was never transitional at all.

## Severity

- 🔴 **VIOLATION** — live transitional code: a compatibility branch, data DML in
  a drizzle migration, or scaffolding whose transition is complete. Has an owner
  and a deletion path.
- 🟡 **SUSPECT** — looks transitional but the transition may be unfinished, or
  the shape is load-bearing for an out-of-tree consumer. Needs a judgement call;
  report the evidence, do not guess.
- ✅ **VERIFIED CLEAN** — surface swept, nothing found. Report what was swept, so
  the coverage claim is checkable.

**No finding without evidence.** Every 🔴 must name the retired form, the code
that still accepts it, and what replaces it. A finding that cannot name its
replacement is 🟡 at best. (Same discipline as `/audit-overengineering`.)

**Verify a sub-agent's blast-radius claim before acting on it.** A sub-agent
reads a slice of the tree and reasons confidently from it; the slice can be the
wrong one. The first run of this audit reported `run_logs.event='document'` as
live data loss — "every DB upgraded from ≤beta.51 silently drops attachments" —
and it was **wrong**: both readers take the file list from the `files` TABLE
(`producedRunFiles` over `/api/files`; the chat card unions that read over its
log chips), and the log event is only a live-frame invalidation nudge, which a
historical row cannot be. A migration nearly got written for a bug that does not
exist. So: before consolidating any finding that claims data loss, a security
hole, or a broken user-visible path, **trace the consumer yourself** — find who
actually reads the value and what else supplies it. Report the correction in the
consolidated report; do not quietly drop it, and do not repeat it.

The reverse discipline applies too: a sub-agent that calls something clean has
only proven it is clean on the surface it swept. Three agents independently
classified `RETIRED_ENV_RENAMES` as exemplary — correctly, on §1's terms — and
none of them was asked whether the guard should exist at all. That question
became §4 and deleted it. A dimension nobody assigned is a dimension nobody
swept.

## Behavior

1. Read `docs/NO_TRANSITIONAL_CODE.md` for the current authoritative rules
2. Record starting state: `git status --short`, `git log --oneline -3`
3. Dispatch **7 opus sub-agents IN PARALLEL** (one message, 7 tool_uses)
4. Wait for all 7
5. Consolidate into `claudedocs/audit-legacy-<date>.md` + an in-chat summary
6. Ask the user which findings to act on — never fix unprompted

## The seven agents

**Agent A — Validators & parsers.** Sweep `packages/core/src`, `packages/env`,
`packages/afps-runtime`, `apps/api/src/lib`, `apps/api/src/services` for any
accept-path admitting more than one form: regex alternations over a prefix or
scheme (`(?:file|doc)_`, `(document|appfile)://`), `??` / `||` fallbacks between
a current and a former field name, `in` checks branching on shape, Zod
`.or()` / `.union()` where one arm is a retired shape, and every "legacy",
"deprecated", "compat", "fallback", "v1", "old" identifier. For each: is the
retired form still WRITTEN anywhere? If not, it is a 🔴.

**Agent B — Drizzle migrations.** Read every `packages/db/drizzle/*.sql`.
Classify each statement as schema (DDL) or data (DML). Report every `UPDATE` /
`INSERT` / `DELETE` / `TRUNCATE` that rewrites row contents, EXCEPT the two
shapes §2 licences on the **same table**, in the same file: a backfill that is
the precondition of a `SET NOT NULL` promotion, a `CHECK` or a
`VALIDATE CONSTRAINT` (the `VALIDATE`, not the `ADD` — the constraint is
routinely added `NOT VALID` a release earlier), and a fold whose source column
that file `DROP`s. A fold whose source column survives is NOT exempt. Read
`docs/NO_TRANSITIONAL_CODE.md` §2 for the exact carve-out and the column-level
limit it does not reach, and note that only an `UPDATE` is ever licenced — an `INSERT`, a `DELETE` or a `TRUNCATE` never is.
`ALTER TABLE … ALTER COLUMN … TYPE … USING <expr>` is the sixth write verb and
the easiest to miss: it evaluates against every existing row and stores the
result, so a repair written there rewrites contents exactly as an `UPDATE` would
while passing through no DML keyword. A pure conversion (a bare column, a cast,
an `AT TIME ZONE`) is not a write; anything else is. The gate scans it now —
verify the gate still matches §2 rather than assuming, and remember `USING` is
also a common keyword (`CREATE INDEX … USING btree`, `ON UPDATE no action`).
Also flag migrations
whose header argues its own necessity from a read-time alias that no longer
exists — that pairing is what produced `0046`. Note: existing files are
permanent and cannot be deleted; the finding is about the PATTERN and what to do
for the next one. Report counts, not a demand to rewrite history.

**Agent C — Dead scaffolding.** Sweep the whole workspace for feature flags
whose branch is decided (grep the flag, then check whether both arms are
reachable), `@deprecated` exports and their caller count, shims/adapters/wrappers
named for a transition, re-export barrels with a single consumer, and
`scripts/` entries that were one-off operational tasks already run. Cross-check
`knip.config.ts` output for unused exports that are transition residue.

**Agent D — Wire & storage contracts.** `apps/api/src/openapi`,
`packages/shared-types`, `apps/web/src`. Find fields, enum members, or response
shapes documented or emitted only for an older client; frontend code reading two
spellings of the same field; SSE/webhook payloads carrying a duplicated legacy
key. Also: storage keys, ids, and URI schemes where the code tolerates an old
prefix.

**Agent E — Env, config & modules.** `packages/env/src/index.ts`,
`docker-compose*.yml`, `.env.example`, `apps/api/src/modules/**`. Verify every
retired env name is in `RETIRED_ENV_RENAMES` and FAILS rather than falls back;
find config keys read under two names; find module-contract branches keyed on a
version or capability that every module now has.

**Agent F — Cross-repo & tests.** `cloud/`, `connect-helper/`, `github-action/`,
plus `test/` fixtures across the workspace.

**Agent G — Retirement machinery (the inverse sweep).** A–F look for
accept-paths: code that TOLERATES a retired form. G looks for the opposite —
**rejection machinery**, code whose only purpose is to detect and refuse one.
This dimension exists because nobody had ever costed that family as a family,
and the first sweep found 16 guards carrying ~257 lines of code behind ~517
lines of prose and ~750 of test, with exactly one recording any condition for
its own removal. Grep `RETIRED`, `retired`, `renamed to`, `no longer read`,
`was renamed`, `grandfathered`, plus any constant mapping an old name to a new
one. For each: what does it refuse, lines of code vs lines of prose, what does
it cost a FRESH install (usually zero at runtime — the cost is reader cost), and
**is its transition over?** Under §4 a finished transition means the guard is
deleted, not dated. Two verdicts G must reach explicitly, because they are where
the dimension earns its keep: (a) would deleting it make the old form SILENT,
and is there a TOOL in the path that should do the rewrite instead (the
`mergeEnv` shape); (b) is it load-bearing for data that works TODAY — a
published content-addressed artifact, a stored token — in which case it was
never transitional and §4 does not reach it. `scripts/migration/*` is NOT in
scope: the doc says those stay.

> **Read `git show origin/main:<path>` in sibling repos, never the working tree.**
> A sibling checkout sits on whatever branch someone left it on, which can
> predate main by weeks. Confirm each repo is actually cloned before sweeping it:
> `github-action/` was NOT present locally on the last run, and the correct
> report is "absent, not swept", never an invented finding. The first run of this audit reported `cloud` pinned to
> `@appstrate/core >=8.0.0` — true of its working tree, which was parked on a
> feature branch, and false of `origin/main`, which had been bumped to `>=9.0.0`
> hours earlier. Run `git -C <repo> fetch -q origin` first, then read from
> `origin/main`. Also confirm each repo's path before sweeping it: the workspace
> layout in `CLAUDE.md` is not always where a clone actually lives. Out-of-tree consumers are the ONE
> legitimate reason a shape survives its in-tree caller — so a finding here must
> state whether the consumer still needs it (check the consumer's source, do not
> assume). Also flag test fixtures that pin a retired shape, which is how a
> compatibility branch acquires a test that justifies keeping it.

## Sub-agent prompt template

Each agent must:

- `Read` `docs/NO_TRANSITIONAL_CODE.md` first — it is the authority
- Grep exhaustively; read any ambiguous file in full
- For every candidate, establish **whether the retired form is still written**.
  A form that is still produced somewhere is not legacy — it is live, and
  removing its reader is a bug. This check is the whole audit.
- Return:

```
# Dimension <X> — <name>
## Violations: N
- file:line — retired form — what still accepts it — what replaces it
## Suspect: N
- file:line — why it looks transitional — what evidence is missing
## Verified clean: N surfaces
- list of what was swept
```

- Never fix anything. This audit reports.

## Consolidation

Write `claudedocs/audit-legacy-<YYYY-MM-DD>.md` containing: total violations by
dimension (all seven), any sub-agent finding you verified and CORRECTED, the full 🔴 list sorted by blast radius, the 🟡 list with the missing
evidence named, the coverage claim (what was swept), and a short "next
retirement" checklist derived from the findings. Then summarise in chat and ask
which to act on.
