# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
boot, and **never** live in `packages/db/drizzle/`.

See `docs/NO_TRANSITIONAL_CODE.md` for why the split exists — both halves of the
`documents` → `files` rename were botched by ignoring it, each costing a
production incident.

## The split

|             | `packages/db/drizzle/*.sql`   | here                 |
| ----------- | ----------------------------- | -------------------- |
| Describes   | schema shape                  | a one-time data fix  |
| Runs        | on every DB, forever, at boot | once, by an operator |
| Reviewed as | a permanent contract          | an operational task  |

The one legitimate overlap: a backfill that is the **precondition** of a
`NOT NULL` or `CHECK` in the same migration file. It cannot be separated from
the constraint it enables, so it stays with it.

## Writing one

`<NNNN>-<slug>.sql` (or `.ts` when it needs logic beyond SQL). Requirements:

1. **Idempotent** — every `WHERE` is exactly the condition it removes, so a
   second run matches zero rows.
2. **One transaction** — `BEGIN` / `COMMIT`, so a failure leaves nothing half-done.
3. **Fenced** — `SET LOCAL lock_timeout` and `statement_timeout`.
4. **Rehearsed** — `pg_dump` production → throwaway `postgres:16-alpine` →
   apply → verify. Record the row counts in the header.
5. **Verifiable** — ship the "before" and "after" queries alongside it.

## Running one

```sh
# 0. ALWAYS dump first
docker exec <pg> pg_dump -U appstrate -d appstrate --no-owner --no-privileges \
  -Fc -f /tmp/pre.dump

# 1. rehearse against a restored copy, never straight at production
# 2. then, and only then:
docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
  -f - < scripts/migration/<NNNN>-<slug>.sql
```

## Log

| #    | date       | what                                            | rows               |
| ---- | ---------- | ----------------------------------------------- | ------------------ |
| 0001 | 2026-08-26 | `files.id` `doc_` → `file_` and every reference | 521 / 25 / 64 / 59 |
