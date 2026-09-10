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

## RBAC rollout (drizzle `0056`, scripts `0008` + `0009` + `0012`, drizzle `0059` — one release or two, step 3 decides)

Apply all of it during the same maintenance window with application traffic stopped:

1. Restore a production dump into a throwaway database and rehearse every step. Record the before/after counts; production volume remains unmeasured until this is done. Verify every org with chat sessions has a default space before `0056` promotes `chat_sessions.space_id` to NOT NULL.
2. **Pre-flight — duplicate pending invitations.** `0056` creates `uq_org_invitations_pending`; a pre-existing duplicate pending pair makes that `CREATE UNIQUE INDEX` raise 23505, which rolls the whole migration back and fails boot. Count the pairs first:

   ```sql
   SELECT count(*) FROM (
     SELECT org_id, email FROM org_invitations
     WHERE status = 'pending' GROUP BY org_id, email HAVING count(*) > 1
   ) d;
   ```

   Non-zero → run `0009-org-invitations-dedupe-pending.sql` and re-run the query until it prints 0.

3. **Pre-flight — does this release carry `0059_drop_org_viewer.sql`?** `0059` recreates `org_role` without `viewer`, and nothing can run between `0056` and it inside one release: drizzle applies the whole pending batch in one transaction and the row scripts run after it. This query decides, and it is `0059`'s own guard run by hand:

   ```sql
   SELECT
     (SELECT count(*) FROM org_members     WHERE role::text = 'viewer')                        AS members,
     (SELECT count(*) FROM org_invitations WHERE role::text = 'viewer' AND status =  'pending') AS pending,
     (SELECT count(*) FROM org_invitations WHERE role::text = 'viewer' AND status <> 'pending') AS history,
     (SELECT count(*) FROM oauth_clients   WHERE signup_role = 'viewer')                        AS clients;
   ```

   **Four zeros** → `0008` and `0012` have nothing to do, and `0056` + `0057` + `0058` + `0059` ship together as one ordinary batch. Steps 5 and 6 are no-ops; run them anyway or skip them.

   **`members`, `pending` or `history` non-zero** → two releases. `0056` + `0008` + `0012` here, `0059` in the next one, because `0008` must READ `viewer` to compute the `space_members` rows that preserve those users' reach and cannot run before `0056` creates that table. Ship `0059` early and its guard fails the deploy — it writes no rows, so it can only refuse, never repair.

   **`clients` non-zero** → a different fault, and neither script clears it. `0056` section G is what flips `oauth_clients.signup_role`, and it validated a narrowed CHECK on its way out, so a surviving `viewer` means `0056` never applied here. Check the `drizzle.__drizzle_migrations` watermark — a corrupted one makes the migrator report nothing pending (see `0004-oauth-resources-watermark-drift.sql`) — before any of the steps below.

   Moving the rows off `viewer` by hand instead of running `0008` collapses the two releases into one, and costs those users their space access until it is restored: `guest` reaches nothing without an explicit `space_members` row, which is precisely what `0008` writes. Only worth it for a handful of accounts, and the restore belongs in this window, not in a follow-up.

4. Apply pending Drizzle migrations — `0056_space_roles.sql`, `0057_oauth_provider_1_7_3.sql`, `0058_organization_deletion_reservation.sql`, and `0059_drop_org_viewer.sql` when step 3 said four zeros.
5. Run `0008-org-viewer-to-guest.sql` before starting the new application. It snapshots memberships, pending viewer invitations and legacy OAuth viewer signup clients into explicit viewer grants, preserving any existing explicit role choices. Reruns do not add later spaces.
6. Run `0012-org-invitation-history-viewer-to-guest.sql` straight after it. `0008` restricts itself to `status = 'pending'` invitations, because only those owe a `space_assignments` snapshot; `0012` maps the accepted, expired and cancelled ones — pure history — to `guest`, which `0059` needs since it cannot cast them.
7. Check zero remaining org-member viewers, zero pending viewer invitations and zero OAuth `signup_role = 'viewer'`. `0008` additionally aborts if any captured membership, invitation or OAuth signup space is missing. Inspect the legacy OAuth snapshots against the rehearsal's pre-migration client/space inventory.
8. Start the new application. Rolling back only the application is unsupported: the older build omits the now-required chat-session space. Roll forward or restore the coordinated backup.

Deleted spaces/custom roles in OAuth signup assignments require updating the client's configuration before new users can join; signup fails without creating partial org/space memberships. Existing members remain able to authenticate. Invitation acceptance retains its existing skip-and-log behavior for deleted targets.

## OAuth-provider 1.7.3 rollout (drizzle `0057`, script `0011`)

1. **Pre-flight, before the 1.7.3 image is deployed.** 1.7.3 reads a stored
   NULL `token_endpoint_auth_method` as `client_secret_basic` and then refuses
   every other method, so a client that authenticates by putting its secret in
   the POST body is answered `invalid_client` the moment the new code serves —
   before `0057` runs, not because of it, since migrations apply at boot under
   that same image. `0057` is why the count cannot wait: its fold writes
   `client_secret_basic` into exactly these rows, and a written value is
   indistinguishable from a registered one, so afterwards nothing enumerates
   them. Run this while the old image is still up and **keep the rows**, not
   just the count:

   ```sql
   SELECT id, client_id, "public", created_at
   FROM oauth_clients
   WHERE token_endpoint_auth_method IS NULL
   ORDER BY created_at;
   ```

   No `public` predicate: the column is nullable and the runtime default is read
   from the method alone, so a row with `public` NULL breaks exactly like a
   `public = false` one. It is also the single case the fold skips
   (`… AND "public" IS NOT NULL`), which is why a count written against the
   fold's own predicate misses it. Save the result with the release's rehearsal
   notes; `0057` drops `public`, so nothing reconstructs the list.

   Any row → decide per client before that image ships: store
   `client_secret_post` by hand, or tell the owner to move to
   `client_secret_basic`. The fail direction is safe either way — a NULL
   resolves to `client_secret_basic`, never to `none`, so no confidential client
   is downgraded to a public one.

2. Apply pending Drizzle migrations, including `0057_oauth_provider_1_7_3.sql`.
   Its section D drops `oauth_clients.public` and `type`; an older build still
   serving inserts clients with those columns and fails 42703, so roll forward
   rather than leaving both builds live.

3. Run `0011-oauth-clients-self-service-fold.sql`. `0057` adds
   `oauth_clients.self_service` as `false` everywhere; this sets it from the
   `metadata` JSON key `selfService`. Until it runs, every self-registered
   client reads as operator-provisioned and `/oauth2/token` does not confine its
   tokens to one protected resource.

   **The API refuses to boot in between, and that is the intended sequence.**
   Migrations apply at boot and this script does not, so the deployment comes up
   only far enough to apply `0057`, counts the rows still unfolded and exits
   naming this file (`assertSelfServiceFoldApplied`, `apps/api/src/lib/boot.ts`);
   under a supervisor it restarts into the same refusal. Run the script against
   the database, then restart. A deployment that never accepted a self-registered
   client counts zero and never sees it.

4. Check the script's `to_fold_after` prints 0 and `self_service_after` grew by
   `to_fold_before`. A non-zero `unparseable_metadata` is a manual read of those
   rows, not a failure.

## Log

| #    | date        | what                                                                                                                                                                                                                                                                                                                                                                                                                             | rows                                                                                                                                                                                                                                                                                                              |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | 2026-08-26  | `files.id` `doc_` → `file_` and every reference                                                                                                                                                                                                                                                                                                                                                                                  | 521 / 25 / 64 / 59                                                                                                                                                                                                                                                                                                |
| 0002 | 2026-08-26  | `chat_messages`: `document://file_` → `appfile://file_`, finishing 0001's write 4                                                                                                                                                                                                                                                                                                                                                | 59                                                                                                                                                                                                                                                                                                                |
| 0003 | 2026-08-28  | `app_` → `spc_` space ids (+18 FK columns), `applications:*` scopes, `end_user:` realms, `level` vocabulary                                                                                                                                                                                                                                                                                                                      | 10750 id rows (33 `spaces` + 10717 across the 18 columns) / 32 scopes / 1+1 realms / 16 reasons / 1 `level`; 17 FKs dropped + restored                                                                                                                                                                            |
| 0004 | not applied | oauth `resources` columns (0006) on a watermark-drifted DB — not rehearsed                                                                                                                                                                                                                                                                                                                                                       | unmeasured                                                                                                                                                                                                                                                                                                        |
| 0005 | 2026-08-28  | AFPS `delivery.http.prefix`: bare auth scheme → separator-carrying (`"Bearer"` → `"Bearer "`), both manifest stores — **one deploy with the `integrationManifestSchema` (1d) gate**; run it FIRST, both spellings render alike under the old code                                                                                                                                                                                | 126 `package_versions` / 77 `packages.draft_manifest`                                                                                                                                                                                                                                                             |
| 0007 | not applied | skills: quote the `description:` lines `yaml` cannot parse, so their drafts are savable again under the SKILL.md frontmatter gate — **run after deploying the gate**; `.ts`, dry-run by default, `--apply` to write                                                                                                                                                                                                              | 17 of 66 skills fixable, 3 need a manual edit (2 `name`, 1 over-long description) — counted on production, NOT rehearsed                                                                                                                                                                                          |
| 0008 | not applied | org role `viewer` → `guest` + an explicit `viewer` `space_members` row in every space that exists; pending invitations and legacy OAuth signup clients carry the same current-space snapshot — **run between drizzle `0056` and bringing the new version up**; viewers are locked out in between                                                                                                                                 | unmeasured — the script prints before/after counts and aborts if any survives. This deployment ran it on nothing: production held 2 viewer members (2 orgs, 1 space each) and 2 accepted viewer invitations on 2026-09-09, moved off `viewer` by hand so the whole rollout could ship as one release — see step 3 |
| 0009 | not applied | `org_invitations`: cancel older duplicate pending rows per (org, email) so drizzle `0056` can create `uq_org_invitations_pending` — **run before the drizzle batch when the rollout pre-flight counts any**; a duplicate pair needs two creates that raced                                                                                                                                                                       | unmeasured — prints the duplicate-pair count before/after, after must be 0                                                                                                                                                                                                                                        |
| 0010 | not applied | the commercial module's billing tables out of the database it used to run on and into the platform database, under the `drizzle.ee_migrations` journal — **run with the platform stopped, before deploying the release that moves the module in-tree**; the source prefix is detected (`cloud_*` at level `0003` is production's), reads `EE_SOURCE_DATABASE_URL` + `DATABASE_URL`, `.ts`, dry-run by default, `--apply` to copy | unmeasured — prints the per-table source/target counts and exits non-zero on any mismatch; refuses a mixed prefix, an unknown `ee_`/`cloud_` table, a source-only column or a non-empty target (exit 1, nothing written), so a second `--apply` refuses rather than double-counting                               |
| 0011 | not applied | `oauth_clients.self_service` set from the `metadata` JSON key `selfService`, which drizzle `0057` leaves behind when it adds the column — **run after the drizzle batch**, which the API refuses to boot past until this has run; rows whose `metadata` is not valid JSON are skipped, not rewritten                                                                                                                             | unmeasured — prints the count it will fold before and after, after must be 0                                                                                                                                                                                                                                      |
| 0012 | not applied | `org_invitations` reading `viewer` with a status other than `pending` — the history `0008` deliberately leaves alone — mapped to `guest`, so drizzle `0059` can recreate the type without the value; **run right after `0008`**                                                                                                                                                                                                  | unmeasured — prints the history and pending counts before and after, history after must be 0                                                                                                                                                                                                                      |
