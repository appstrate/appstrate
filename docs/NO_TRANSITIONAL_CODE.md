# No transitional code

**The rule.** The codebase describes how the system works _now_. It never
describes how it used to work, and it never carries a bridge between the two.
Code that exists only to survive a transition is deleted the moment the
transition is over — and the transition is over when the data has moved, not
when the release ships.

This is a _minimality_ rule, not a purity one. Every compatibility branch is a
second code path that no test exercises on purpose, that no reader can date, and
that quietly changes what the primary path means.

## The three prohibitions

### 1. No backward-compatibility branches

A validator, parser, or resolver accepts exactly one form: the current one.

```ts
// ❌ makes a retired spelling legal forever
export const FILE_ID_RE = /^(?:file|doc)_[A-Za-z0-9_-]{8,}$/;

// ✅ one form written, the same one read
export const FILE_ID_RE = /^file_[A-Za-z0-9_-]{8,}$/;
```

If production data does not match the current form, **the data is wrong, not the
validator**. Move the data (§2). An alias added "just until the data catches up"
outlives the reason it was added, because nothing records when that reason
expires.

The same applies to: legacy field aliases, `X ?? legacyX` fallbacks, dual-read
paths, "accept both shapes" JSON parsing, and env-var aliases. When a name
changes, the old name must **fail loudly** — see `RETIRED_ENV_RENAMES`
(`packages/env/src/index.ts`), which refuses to boot rather than silently
falling back to a default. That is the correct shape for a retirement.

### 2. Data repair lives in `scripts/migration/`, never in a drizzle migration

`packages/db/drizzle/*.sql` describes the **schema**: tables, columns, indexes,
constraints, types. It is replayed on every database that has ever existed,
forever, and every file in it is permanent.

A one-off rewrite of row _contents_ is not schema. It is an operational task
that runs once, against one deployment, and is then finished. It belongs in
`scripts/migration/<NNNN>-<slug>.{sql,ts}`, run deliberately by an operator, with its
own verification queries.

|             | drizzle migration          | `scripts/migration/`                   |
| ----------- | -------------------------- | -------------------------------------- |
| Describes   | schema shape               | a one-time data fix                    |
| Runs        | on every DB, forever       | once, on the deployments that need it  |
| Reviewed as | permanent contract         | an operational task                    |
| Example     | `ALTER TABLE … ADD COLUMN` | rewrite 521 ids from `doc_` to `file_` |

A backfill that is the **precondition** of a constraint is the one legitimate
overlap — it cannot be separated from the constraint it enables. Three clauses
qualify: `SET NOT NULL` (`0051`), `CHECK` (`0038`) and `VALIDATE CONSTRAINT`
(`0021`). The constraint must land on the **same table** the backfill repairs;
file-level, a constraint on table A would licence a rewrite of table B. Keep it
minimal, and keep it in the same file as the constraint.

`SET NOT NULL` is a _promotion_, and only a promotion counts. A `NOT NULL` in a
column definition never had a backfill as its precondition: Postgres refuses
`ADD COLUMN … NOT NULL` on a populated table without a `DEFAULT`, and that
default already satisfies the constraint. `0018` is the live example — it adds
`runs.version_ref` with a default and then rewrites `runs`, so reading this
carve-out as "any `NOT NULL`" would licence plain data repair on the very table
the migration rewrites.

What it does not separate: a constraint and an _unrelated_ repair on the same
table. `0023` adds a `CHECK` to `llm_usage` and, in the same file, backfills a
different `llm_usage` column — structurally indistinguishable from `0038`, where
the `CHECK` covers the column the `UPDATE` fills. Telling the two apart needs
column-level analysis and is out of scope. The gap is a limit, not permission.

`bun run verify:no-migration-dml` enforces all of this; every migration that
predates the gate is grandfathered in `scripts/verify-no-migration-dml.ts` by
name.

Its write vocabulary is `UPDATE`, `INSERT`, `DELETE` and `TRUNCATE`, in every
position a statement can open — including a CTE, since
`WITH moved AS (DELETE … RETURNING *) INSERT INTO other …` is the idiomatic way
to move rows between tables and is squarely a `scripts/migration/` job. A
`TRUNCATE` is never licenced by the carve-out: emptying a table satisfies every
constraint vacuously, so "drop all rows, then promote the column" is not a
precondition, it is the destruction this rule exists to stop.

Two writing forms are outside that vocabulary on purpose. `SELECT … INTO` is
PL/pgSQL variable assignment inside the `DO $$` blocks this directory is full
of, and creates a new relation rather than rewriting rows; `COPY … FROM` needs
a file on the database host or `FROM STDIN`, and the boot migrator supplies
neither. Both are named here so the omission stays a decision rather than a
gap.

### 3. No dead transition scaffolding

Feature flags whose branch is decided, shims, adapters wrapping a shape nothing
emits, `@deprecated` exports with no remaining caller, and re-export barrels
that exist only so an old import path keeps resolving: delete them with the
transition, in the same PR that completes it.

## Why this is written down

Both halves of this rule were broken by the same rename (#1177,
`documents` → `files`), and each break cost a production incident:

- **The data half went into drizzle migrations and was then deleted.**
  `0044_documents_scope_strings` and `0045_documents_scope_delimited_strings`
  rewrote persisted permission scope strings. Both were deleted when the
  physical rename took their numbers, on the reasoning that a read-time
  canonicalization already covered them. The commit that removed that
  canonicalization cited these migrations as the reason it was redundant. Each
  argument was sound alone; together they left every database upgraded from
  `v1.0.0-beta.51` with **neither half**, silently under-granting API-key
  permissions. `0046_legacy_permission_scope_strings` exists only to restore
  what was deleted.

- **The id half was never written at all.** `0043` renamed the table and `0044`
  rewrote `storage_key`; neither touched `files.id`. Production carried 521 rows
  with a `doc_` id and 0 with `file_`, while `FILE_ID_RE` accepted only `file_`
  — and `loadFileForPreview` tests it _before_ any SELECT. On
  `v1.0.0-beta.53` every stored file returned 404 on preview and download at
  once. The data was moved by a one-off script; the validator was left strict.

Note what the second incident says about §1: widening the regex would have
restored service in one line. It was rejected because the line would still be
there in a year, legalising a spelling nothing should write, with no record of
why.

## How to retire something correctly

1. Change the code to the new form only. No alias, no fallback.
2. Write the data fix as `scripts/migration/<NNNN>-<slug>.{sql,ts}`, idempotent, with
   a `WHERE` clause that is exactly the condition it removes.
3. Rehearse it against a restored copy of production (`pg_dump` → throwaway
   container → apply → verify). Record the row counts.
4. Run it, verify, and delete nothing else — the script stays as the record of
   what was done, outside the replay path.
5. If the old form can still arrive from outside (an env var, a stored token, a
   third-party payload), make it **fail loudly**. Never make it work.

## Audit

`/audit-legacy` dispatches parallel sub-agents across the whole workspace and
reports every violation of this document. Run it before a release, and after any
rename or refactor that spans a schema and its data.
