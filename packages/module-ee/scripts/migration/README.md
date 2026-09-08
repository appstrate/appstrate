# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
`migrateCloudDb()`, and **never** live in `drizzle/migrations/`.

The rule and every reason behind it live in the platform's
`docs/NO_TRANSITIONAL_CODE.md` §2, which is the authority for this repo too.

## The split

`drizzle/migrations/*.sql` describes schema shape, is replayed on every cloud
database at module `init()` forever, and is reviewed as a permanent contract; a
script here fixes data once, on the deployments that need it, and is reviewed as
an operational task. The one legitimate overlap — a backfill that is the
**precondition** of a `SET NOT NULL` promotion, a `CHECK`, or a
`VALIDATE CONSTRAINT` landing on the **same table**, never a `TRUNCATE` — is
stated in full, with its limits, in `docs/NO_TRANSITIONAL_CODE.md` §2;
`bun run verify:no-migration-dml` enforces the table-level half of it.

This directory is empty. Two migrations predate the gate and carry data repair
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

Money is the thing this database holds. A task that touches `credits_used`,
`credit_quota`, `cost_credits` or `cost_usd` is rehearsed against a restored
copy, never reasoned about in the abstract — the billing sweep derives each
debit as a **delta** against the stored cumulative (`src/billing/usage-recorder.ts`),
so a rewritten cumulative silently re-bills or under-bills the next pass.

## Running one

Cloud has one operator-script convention and it is worth following: a task with
logic gets a named `package.json` script that runs a `.ts` file, the way
`repair:account` → `src/scripts/repair-account.ts` does. Such a script opens the
database itself with `initCloudDb(getCloudEnv().CLOUD_DATABASE_URL)` and never
touches the platform, so it runs against a live deployment without the API
process. Add the entry alongside `repair:account`:

```jsonc
"migrate:0001-<slug>": "bun run scripts/migration/0001-<slug>.ts",
```

A pure-SQL task needs no entry — run it through `psql` against
`CLOUD_DATABASE_URL` (the **cloud** database, which is not the platform's):

```sh
# 0. ALWAYS dump first
docker exec <pg> pg_dump "$CLOUD_DATABASE_URL" --no-owner --no-privileges \
  -Fc -f /tmp/pre.dump

# 1. rehearse against a restored copy, never straight at production
# 2. then, and only then:
docker exec -i <pg> psql "$CLOUD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f - < scripts/migration/<NNNN>-<slug>.sql
```

## Log

| #   | date | what         | rows |
| --- | ---- | ------------ | ---- |
|     |      | _(none yet)_ |      |
