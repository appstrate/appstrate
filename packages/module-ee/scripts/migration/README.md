# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
`migrateEeDb()`, and **never** live in `drizzle/migrations/`.

The rule and every reason behind it live in `docs/NO_TRANSITIONAL_CODE.md` §2 at
the repository root, which is the authority.

## The split

`drizzle/migrations/*.sql` describes schema shape, is replayed at module
`init()` on every platform database this module is enabled on, forever, and is
reviewed as a permanent contract; a
script here fixes data once, on the deployments that need it, and is reviewed as
an operational task. The one legitimate overlap — a backfill that is the
**precondition** of a `SET NOT NULL` promotion, a `CHECK`, or a
`VALIDATE CONSTRAINT` landing on the **same table**, never a `TRUNCATE` — is
stated in full, with its limits, in `docs/NO_TRANSITIONAL_CODE.md` §2;
`bun run verify:no-migration-dml` enforces the table-level half of it.

This directory is empty. The one-off that moved this module's rows out of the
database it used to run on and into the platform one is
`scripts/migration/0010-ee-tables-into-platform-db.ts` at the REPOSITORY root,
not here: it opens two databases and imports `migrateEeDb`, so it belongs to the
platform's operator set, and the module README's "Moving an existing deployment"
states its behaviour (prefix autodetect, a `cloud_*` source at level `0003`, and
what it refuses).

Two migrations predate the gate and carry data repair
that should have landed here; they are permanent and listed by name in
`scripts/verify-no-migration-dml.ts`, with the reasoning for each. They are not
log entries below — they already ran as migrations, and nothing about them is
re-runnable from here.

## Writing one

`<NNNN>-<slug>.sql`, or `<NNNN>-<slug>.ts` when it needs logic beyond SQL.
Requirements:

1. **Idempotent** — every `WHERE` is exactly the condition it removes, so a
   second run matches zero rows.
2. **One transaction** — `BEGIN` / `COMMIT`, so a failure leaves nothing
   half-done.
3. **Fenced** — `SET LOCAL lock_timeout` and `statement_timeout`.
4. **Rehearsed** — `pg_dump` production → throwaway `postgres:16-alpine` →
   apply → verify. Record the row counts in the header.
5. **Verifiable** — ship the "before" and "after" queries alongside it.

Money is what these tables hold. A task that touches `credits_used`,
`credit_quota`, `cost_credits` or `cost_usd` is rehearsed against a restored
copy, never reasoned about in the abstract — the billing sweep derives each
debit as a **delta** against the stored cumulative (`src/billing/usage-recorder.ts`),
so a rewritten cumulative silently re-bills or under-bills the next pass.

## Running one

This module has one operator-script convention and it is worth following: a task with
logic gets a named `package.json` script that runs a `.ts` file, the way
`repair:account` → `src/scripts/repair-account.ts` does. Such a script opens the
database itself, the way `repair:account` does, so it runs against a live
deployment without the API process. Add the entry alongside `repair:account`:

```jsonc
"migrate:0001-<slug>": "bun run scripts/migration/0001-<slug>.ts",
```

A pure-SQL task needs no entry — run it through `psql` against
`DATABASE_URL`, the platform database, where the `ee_*` tables live:

```sh
# 0. ALWAYS dump first — restrict it to this module's tables
docker exec <pg> pg_dump "$DATABASE_URL" --no-owner --no-privileges \
  -t 'ee_*' -Fc -f /tmp/pre.dump

# 1. rehearse against a restored copy, never straight at production
# 2. then, and only then:
docker exec -i <pg> psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f - < scripts/migration/<NNNN>-<slug>.sql
```

## Log

| #   | date | what         | rows |
| --- | ---- | ------------ | ---- |
|     |      | _(none yet)_ |      |
