# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
boot, and **never** live in `packages/db/drizzle/`.

See `docs/NO_TRANSITIONAL_CODE.md` for why the split exists — both halves of the
`documents` → `files` rename were botched by ignoring it, each costing a
production incident.

## The split

`packages/db/drizzle/*.sql` describes schema shape, is replayed on every
database at boot forever, and is reviewed as a permanent contract; a script
here fixes data once, on the deployments that need it, and is reviewed as an
operational task. The two legitimate overlaps — a backfill that is the
**precondition** of a `SET NOT NULL` promotion, a `CHECK`, or a
`VALIDATE CONSTRAINT`, and a fold whose source column the same file `DROP`s —
each an `UPDATE` landing on the **same table** (an `INSERT`, a `DELETE` or a `TRUNCATE` is never licenced), are stated in full,
with their limits, in `docs/NO_TRANSITIONAL_CODE.md` §2, which is the
authority; `bun run verify:no-migration-dml` enforces it.

## Writing one

`<NNNN>-<slug>.sql` (or `.ts` when it needs logic beyond SQL). Requirements:

1. **Idempotent** — every `WHERE` is exactly the condition it removes, so a
   second run matches zero rows.
2. **One transaction** — `BEGIN` / `COMMIT`, so a failure leaves nothing half-done.
3. **Fenced** — `SET LOCAL lock_timeout` and `statement_timeout`.
4. **Rehearsed** — `pg_dump` production → throwaway `postgres:16-alpine` →
   apply → verify. Record the row counts in the header. When the script repairs
   a state no reachable database is in — `0004` — say so in the header and mark
   the counts UNMEASURED, so a reader never mistakes a required value for an
   observed one.
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

## RBAC rollout (drizzle `0056`, scripts `0008` + `0009`)

Apply all of it during the same maintenance window with application traffic stopped:

1. Restore a production dump into a throwaway database and rehearse every step. Record the before/after counts; production volume remains unmeasured until this is done. Verify every org with chat sessions has a default space before `0056` promotes `chat_sessions.space_id` to NOT NULL.
2. **Pre-flight, before any drizzle migration.** `0056` creates `uq_org_invitations_pending`; a pre-existing duplicate pending pair makes that `CREATE UNIQUE INDEX` raise 23505, which rolls the whole migration back and fails boot. Count the pairs first:

   ```sql
   SELECT count(*) FROM (
     SELECT org_id, email FROM org_invitations
     WHERE status = 'pending' GROUP BY org_id, email HAVING count(*) > 1
   ) d;
   ```

   Non-zero → run `0009-org-invitations-dedupe-pending.sql` and re-run the query until it prints 0.

3. Apply pending Drizzle migrations, including `0056_space_roles.sql`.
4. Run `0008-org-viewer-to-guest.sql` before starting the new application. It snapshots memberships, pending viewer invitations and legacy OAuth viewer signup clients into explicit viewer grants, preserving any existing explicit role choices. Reruns do not add later spaces.
5. Check zero remaining org-member viewers, zero pending viewer invitations and zero OAuth `signup_role = 'viewer'`. `0008` additionally aborts if any captured membership, invitation or OAuth signup space is missing. Inspect the legacy OAuth snapshots against the rehearsal's pre-migration client/space inventory.
6. Start the new application. Rolling back only the application is unsupported: the older build omits the now-required chat-session space. Roll forward or restore the coordinated backup.

Deleted spaces/custom roles in OAuth signup assignments require updating the client's configuration before new users can join; signup fails without creating partial org/space memberships. Existing members remain able to authenticate. Invitation acceptance retains its existing skip-and-log behavior for deleted targets.

## Log

| #    | date        | what                                                                                                                                                                                                                                                                                                                                                                                                                             | rows                                                                                                                                                                                                                                                                                |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | 2026-08-26  | `files.id` `doc_` → `file_` and every reference                                                                                                                                                                                                                                                                                                                                                                                  | 521 / 25 / 64 / 59                                                                                                                                                                                                                                                                  |
| 0002 | 2026-08-26  | `chat_messages`: `document://file_` → `appfile://file_`, finishing 0001's write 4                                                                                                                                                                                                                                                                                                                                                | 59                                                                                                                                                                                                                                                                                  |
| 0003 | 2026-08-28  | `app_` → `spc_` space ids (+18 FK columns), `applications:*` scopes, `end_user:` realms, `level` vocabulary                                                                                                                                                                                                                                                                                                                      | 10750 id rows (33 `spaces` + 10717 across the 18 columns) / 32 scopes / 1+1 realms / 16 reasons / 1 `level`; 17 FKs dropped + restored                                                                                                                                              |
| 0004 | not applied | oauth `resources` columns (0006) on a watermark-drifted DB — not rehearsed                                                                                                                                                                                                                                                                                                                                                       | unmeasured                                                                                                                                                                                                                                                                          |
| 0005 | 2026-08-28  | AFPS `delivery.http.prefix`: bare auth scheme → separator-carrying (`"Bearer"` → `"Bearer "`), both manifest stores — **one deploy with the `integrationManifestSchema` (1d) gate**; run it FIRST, both spellings render alike under the old code                                                                                                                                                                                | 126 `package_versions` / 77 `packages.draft_manifest`                                                                                                                                                                                                                               |
| 0007 | not applied | skills: quote the `description:` lines `yaml` cannot parse, so their drafts are savable again under the SKILL.md frontmatter gate — **run after deploying the gate**; `.ts`, dry-run by default, `--apply` to write                                                                                                                                                                                                              | 17 of 66 skills fixable, 3 need a manual edit (2 `name`, 1 over-long description) — counted on production, NOT rehearsed                                                                                                                                                            |
| 0008 | not applied | org role `viewer` → `guest` + an explicit `viewer` `space_members` row in every space that exists; pending invitations and legacy OAuth signup clients carry the same current-space snapshot — **run between drizzle `0056` and bringing the new version up**; viewers are locked out in between                                                                                                                                 | unmeasured — the script prints before/after counts and aborts if any survives                                                                                                                                                                                                       |
| 0009 | not applied | `org_invitations`: cancel older duplicate pending rows per (org, email) so drizzle `0056` can create `uq_org_invitations_pending` — **run before the drizzle batch when the rollout pre-flight counts any**; a duplicate pair needs two creates that raced                                                                                                                                                                       | unmeasured — prints the duplicate-pair count before/after, after must be 0                                                                                                                                                                                                          |
| 0010 | not applied | the commercial module's billing tables out of the database it used to run on and into the platform database, under the `drizzle.ee_migrations` journal — **run with the platform stopped, before deploying the release that moves the module in-tree**; the source prefix is detected (`cloud_*` at level `0003` is production's), reads `EE_SOURCE_DATABASE_URL` + `DATABASE_URL`, `.ts`, dry-run by default, `--apply` to copy | unmeasured — prints the per-table source/target counts and exits non-zero on any mismatch; refuses a mixed prefix, an unknown `ee_`/`cloud_` table, a source-only column or a non-empty target (exit 1, nothing written), so a second `--apply` refuses rather than double-counting |
