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

A `NOT NULL` promotion that requires a backfill is the one legitimate overlap:
the backfill is the precondition of the constraint and cannot be separated from
it. Keep it minimal, and keep it in the same file as the constraint it enables.

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
