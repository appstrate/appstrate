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

A write that **cannot be separated** from the schema change beside it is the one
legitimate overlap. Two shapes qualify, and nothing else.

**The precondition of a constraint.** Three clauses: `SET NOT NULL` (`0051`),
`ADD CONSTRAINT … CHECK` (`0038`), `VALIDATE CONSTRAINT` (`0021`). The test is
not where the constraint is born but **whether that clause scans the rows that
already exist** — only then can a repair beside it be the precondition of
anything. Three consequences, and the gate implements all three:

- `ADD CONSTRAINT … CHECK (…)` licences, because Postgres validates the whole
  table as it adds it. Creation and enforcement are the same moment.
- `ADD CONSTRAINT … CHECK (…) NOT VALID` licences **nothing**. Postgres
  deliberately skips the existing rows, so the rows a repair would fix are
  exactly the rows the `NOT VALID` just excused. Repair them beside the
  `VALIDATE`, in the file that turns the constraint on. Without this the
  recommended two-step pattern would licence arbitrary repair in the first
  file, the one where nothing is enforced.
- A `CHECK` in a **column definition** (`ADD COLUMN c int CHECK (…)`, or one
  inside a `CREATE TABLE`) licences nothing either — the same reason a
  `NOT NULL` in a column definition does not, below. The column is new, so
  every existing row satisfies it vacuously.

That `NOT VALID` split is the safe pattern on a large table: add the constraint
in one release, then repair and `VALIDATE` in a later one, with the repair
beside the `VALIDATE`. So the constraint is added in a different file from the
backfill that preconditions it. `0020`/`0021` are that pair, and `0018`'s own
header tells future migrations to use it. It is the `VALIDATE` that must share
the file with the repair — never the `ADD`.

**A fold whose source column is dropped in the same file.** `DROP COLUMN`
destroys the values, so an operator script run afterwards would have nothing left
to read: the fold is as inseparable from the `DROP` as a backfill is from a
`SET NOT NULL`. `0018` folds `version_dirty` into `runs.version_ref` and drops it
on the next line; `0040` does it twice more. The `DROP` is the whole bound — a
fold whose source **survives** is ordinary data repair and is not exempt.
`0040`'s `application_packages` wrap keeps the column it reads, and `0033`'s
second `UPDATE` strips a key out of a `runs.metadata` it keeps: both are
violations, not folds.

Either way the licensing clause must land on the **same table** the write
touches; file-level, a `CHECK` on table A would licence a rewrite of table B.
Keep the write minimal, and keep it in the file that carries the clause.

And either way the licenced write is an **`UPDATE`** — no clause licences an
`INSERT`, a `DELETE` or a `TRUNCATE`. `DELETE FROM t;` empties a table exactly as
`TRUNCATE t;` does, and "drop all the rows, then promote the column" satisfies
any constraint vacuously: the destruction this rule exists to stop, wearing a
precondition's clothes. Licensing is closed by default and opened for the one
verb both shapes are actually written in.

This is a deliberate trade, not a claim that nothing else could ever qualify.
Two shapes genuinely are inseparable and are still refused: deleting orphan rows
before a `VALIDATE CONSTRAINT` on a non-nullable FK (`0021` escaped it only
because its column is nullable, so `SET … = NULL` was available), and folding a
column into a CHILD table (`INSERT INTO child SELECT … FROM parent;`) before the
parent `DROP`s it. Both are rare, both are destructive enough to deserve a human
reading them, and admitting either would re-open `DELETE FROM t;` beside a
`SET NOT NULL`. Write them as `scripts/migration/` scripts and split the
constraint into the next release.

`SET NOT NULL` is a _promotion_, and only a promotion counts. A `NOT NULL` in a
column definition never had a backfill as its precondition: Postgres refuses
`ADD COLUMN … NOT NULL` on a populated table without a `DEFAULT`, and that
default already satisfies the constraint. `0018` is the live example — it adds
`runs.version_ref` with a default and then rewrites `runs`, so reading this
carve-out as "any `NOT NULL`" would licence that rewrite on the strength of a
constraint nothing preconditions. The rewrite _is_ licenced — by the `DROP
COLUMN` on the next line, which bounds it to the values that column is about to
take with it.

What it does not separate: a licensing clause and an _unrelated_ repair on the
same table. `0023` adds a `CHECK` to `llm_usage` and, in the same file, backfills
a different `llm_usage` column — structurally indistinguishable from `0038`,
where the `CHECK` covers the column the `UPDATE` fills. A `DROP COLUMN` has the
same reach: it licences the fold of the column it drops, and cannot tell that
apart from a rewrite of a column it leaves alone. Telling the two apart needs
column-level analysis and is out of scope. The gap is a limit, not permission.

`bun run verify:no-migration-dml` enforces the table-level half of this section
and nothing else: a write in a new migration must be licenced by one of those
four clauses landing on the table it writes. The column-level gap just
described is out of its reach, and §1 and §3 have no automated gate at all.
Every migration that predates the gate is grandfathered in
`scripts/verify-no-migration-dml.ts` by name.

Its write vocabulary is `UPDATE`, `INSERT`, `DELETE`, `TRUNCATE` and `MERGE`,
in every position a statement can open — including a CTE, since
`WITH moved AS (DELETE … RETURNING *) INSERT INTO other …` is the idiomatic way
to move rows between tables and is squarely a `scripts/migration/` job. Of those
five only an `UPDATE` can ever be licenced, per the rule above. Licensing is
closed by default and opened for the one verb the carve-out describes, rather
than open by default and closed for `TRUNCATE` — otherwise `DELETE FROM t;`
beside a `SET NOT NULL` on `t` passes a gate whose whole purpose is to stop a
migration from destroying rows on every database it is replayed against, and a
fifth verb added to the vocabulary later would inherit an exemption nobody
argued for.

`MERGE` is that fifth verb, and it inherited nothing. PostgreSQL 16 writes rows
in all three directions with it, and one statement can insert, update and delete
at once — so a `MERGE` beside a `SET NOT NULL` would be `DELETE FROM t;` beside
a `SET NOT NULL` with a longer spelling, which is the case the previous
paragraph closed. It is therefore in the vocabulary and outside the carve-out. A
backfill that genuinely preconditions a constraint is expressible as an
`UPDATE`; writing it as a `MERGE` is a choice, and the remedy is to write the
`UPDATE`. Before it was named the gate caught it only by ACCIDENT — through the
`UPDATE` behind its `WHEN MATCHED THEN` — and reported the table as `set`.

**A command string is code.** `EXECUTE format('UPDATE t SET x = 1')` writes rows
at apply time exactly as the bare statement would, and it is written inside a
string literal — which the gate blanks, because a migration header discussing
`UPDATE` in prose is the common case here. So the gate also reads the argument of
every `EXECUTE` and `format(…)` as the SQL it becomes. This is not a hypothetical
bypass: `EXECUTE format(…)` is already the dominant form here for catalog-guarded
DDL — a couple of dozen sites, spread across the rename migrations and growing
with every new one, so it is the form the next author reaches for. Derive the
figure rather than reading one here, because it has drifted before —
`grep -o 'EXECUTE format(' packages/db/drizzle/*.sql | wc -l` prints it as one
number (`grep -c` over the same glob prints one line per file, almost all
`:0`). That total counts every occurrence, including the handful sitting inside
`--` comments, so it runs ahead of the number of live statements. What is worth
re-checking is not the total but the invariant behind it — every site is a `RENAME`, a
`DROP CONSTRAINT` or a probe, and not one is a write. A write found there is
reported unconditionally, with no carve-out: the target is typically a `%I`
filled from a catalog query, so there is no table name a licence could land on.

**A `CREATE FUNCTION` body is not.** `CREATE FUNCTION audit_fn() … $$ BEGIN
INSERT INTO audit …; RETURN NEW; END; $$` writes no row when the migration is
applied — it writes a `pg_proc` entry, which is schema. The `INSERT` runs later,
per row, when something touches the table the trigger is on: the application's
behaviour, not a one-off repair. So a `CREATE [OR REPLACE] FUNCTION` /
`PROCEDURE` body is read as neither a write nor a licence — as neither, because
exempting it from the write scan alone would turn a function definition into a
way to manufacture a licence for a write elsewhere in the file. Every way of
writing a body is exempt, because "a function body" is what is exempt and no
spelling is the exception: a dollar quote, the `BEGIN ATOMIC … END` that
PostgreSQL 14 added for `LANGUAGE sql`, and a plain string — the last needing
nothing special, since an ordinary literal is blanked in both directions
anyway.

**A `DO` block is the counter-case** and is **not** exempt, _however its code is
quoted_: it executes at apply time against the rows that exist, which is
precisely what this section forbids (`0021`, `0023`, `0040` and `0051` are that
shape). The distinction is the `CREATE … FUNCTION` in front of the body — never
the quoting, which is a lexical choice with no meaning here. `DO [LANGUAGE lang]
code` takes a **string constant**, and `$$ … $$` is only one way to write one:
`DO 'BEGIN UPDATE t SET x = 99; END';` is the same statement as its dollar-quoted
twin and rewrites the same rows on every replay. The gate reads a `DO` body as
code either way, in the same pass, so the same-table carve-out reaches both.

**A `USING` expression is a write.**
`ALTER TABLE t ALTER COLUMN c SET DATA TYPE <type> USING <expr>` evaluates
`<expr>` against every row that already exists and stores what it returns. A
type cast is the honest use, and this directory is full of them — `0047` alone
has thirty, all `AT TIME ZONE 'UTC'`. But nothing stops the expression being a
repair: `USING (CASE WHEN c = 'old' THEN 'new' ELSE c END)` rewrites row
contents exactly as the `UPDATE` beside it would, and it is the shape `0053`
deliberately refused to write, so it is the shape the next author reaches for.
It is therefore a sixth verb in the vocabulary, with the table read from the
`ALTER TABLE` it opens and the same carve-out available: a repair whose
`USING` lands on the table a `SET NOT NULL`, a `CHECK`, a `VALIDATE` or a
`DROP COLUMN` in the same file also lands on is licenced, and nothing else is.
A cast with no repair in it — `USING c::text`, `USING c AT TIME ZONE 'UTC'` — is
not a write: the gate reads a bare column reference, a cast of one, and an
`AT TIME ZONE` on one as conversion, and anything else as a repair.

Two writing forms are outside that vocabulary on purpose. `SELECT … INTO` is
PL/pgSQL variable assignment inside the `DO` blocks this directory is full of,
and creates a new relation rather than rewriting rows; `COPY … FROM` needs a
file on the database host or `FROM STDIN`, and the boot migrator supplies
neither. Both are named here so the omission stays a decision rather than a
gap.

Two limits remain in the way literals are read, named for the same reason. The
walker assumes `standard_conforming_strings` is on — the PostgreSQL default,
and what the boot migrator runs under — which is what makes `E'…'` the one form
where a backslash escapes the next character; a session that turned the setting
off would make every literal escape-processing, and that is not modelled. And
inside a `DO '…'` body a nested literal is written with doubled quotes
(`''…''`), of which only the quote pairs are blanked, so a DML keyword parked
in a nested VALUE there can read as a statement. That direction is the safe
one, and the remedy is to reword or to use the dollar quote.

Three limits remain in that dynamic-SQL reading, named for the same reason. A
command _concatenated_ rather than formatted (`stmt := 'UPDATE ' || t; EXECUTE
stmt;` — it passes through neither an `EXECUTE` nor a `format(` while it is being
built), and a verb interpolated rather than written (`format('%s t SET …',
verb)`), both need to follow a value through PL/pgSQL and are not seen; what is
closed is the case that reads as ordinary SQL. `stmt := format('UPDATE …');
EXECUTE stmt;` — the same bypass in two statements — _is_ seen, because a
`format(…)` is read wherever it appears. And in the other direction, a
`format(…)` building a MESSAGE rather than a command (`RAISE EXCEPTION '%',
format('DELETE failed on %I', t)`) reads as a write and is reported; that
direction is the safe one, and the remedy is to reword the message.

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
