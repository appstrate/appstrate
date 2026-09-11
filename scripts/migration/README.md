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

4. Apply pending Drizzle migrations — `0056_space_roles.sql`, `0057_oauth_provider_1_7_3.sql`, `0058_organization_deletion_reservation.sql`, `0059_drop_org_viewer.sql` when step 3 said four zeros, then `0060_runner_preset.sql`, `0061_oauth_fk_indexes.sql` and `0062_org_models_unique_binding.sql`.
5. Run `0008-org-viewer-to-guest.sql` before starting the new application. It snapshots memberships, pending viewer invitations and legacy OAuth viewer signup clients into explicit viewer grants, preserving any existing explicit role choices. Reruns do not add later spaces: a run that commits records itself in `drizzle.migration_scripts`, and every later run skips `0008`'s own step 4 (the OAuth signup snapshot) outright — naming the OAuth signup clients whose empty snapshot its predicate still matches, and which it would otherwise have widened. Re-running `0008`'s step 4 on purpose means deleting that row by hand.
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

## Personal spaces & sharing rollout (drizzle `0063` + `0064` + `0065`, scripts `0014` + `0015`)

ONE release, and the three migrations apply as a single boot batch. Two scripts,
and they sit on opposite sides of the window: `0014` runs **inside** it and is
not optional, `0015` runs **after** the release is validated and is optional
forever. Nothing here needs a new environment variable.

Read the header of each file too — it is the authority on what that file touches.

### 1. Rehearse

Restore a production dump into a throwaway `postgres:16-alpine` and run every
step below against it. Record the counts; production volume is UNMEASURED for
both scripts until this is done.

### 2. Pre-flight — which packages `0014` has to guess about

`0063` adds `packages.home_space_id` NULL on every row, and NULL means "the
organization catalogue: owners and admins on a session". Between the migration
and `0014` every non-owner author and **every API key** is locked out of its own
packages, which is why step 5 stops traffic. `0014` then picks a home per
package: one installation → that space, several → the OLDEST `installed_at`,
none → left NULL.

Only the "several" case is a guess. Count them on the replica (`ssh appstrate`).
The column does not exist yet there, so these run WITHOUT `0014`'s
`home_space_id IS NULL` clause — before the migration every row qualifies:

```sql
SELECT
  count(*)                               AS org_packages,
  count(*) FILTER (WHERE i.installs = 1) AS exactly_one_install,
  count(*) FILTER (WHERE i.installs > 1) AS several_installs,
  count(*) FILTER (WHERE i.installs = 0) AS installed_nowhere
FROM packages p
JOIN LATERAL (
  SELECT count(*) AS installs
  FROM space_packages sp
  JOIN spaces s ON s.id = sp.space_id
  WHERE sp.package_id = p.id AND s.org_id = p.org_id
) i ON true
WHERE p.org_id IS NOT NULL AND p.ephemeral = false;
```

`several_installs` non-zero → list them and review each with its author, because
"the first space to install it" is a good guess and not a fact:

```sql
SELECT
  p.id     AS package_id,
  p.org_id,
  count(*) AS installations,
  (array_agg(sp.space_id ORDER BY sp.installed_at, sp.space_id))[1] AS chosen_space_id,
  min(sp.installed_at)                                              AS chosen_installed_at
FROM packages p
JOIN space_packages sp ON sp.package_id = p.id
JOIN spaces s ON s.id = sp.space_id AND s.org_id = p.org_id
WHERE p.org_id IS NOT NULL AND p.ephemeral = false
GROUP BY p.id, p.org_id
HAVING count(*) > 1
ORDER BY p.id;
```

`0014` prints this same list before its `UPDATE`: review it and `ROLLBACK`
instead of `COMMIT` if a row looks wrong. Whatever it picks stays correctable
afterwards with `PATCH /api/packages/{scope}/{name} {"home_space_id": …}`.

### 3. Pre-flight — what the two `RESTRICT`s make undeletable

`0063` and `0064` each add an `ON DELETE RESTRICT` edge, and both are deliberate
refusals rather than cascades. Know what they will refuse:

- **`packages.home_space_id → spaces.id`.** After `0014`, a space that homes a
  package cannot be deleted: the API answers `409 space_homes_packages` and
  names the packages, and a hand-written `DELETE FROM spaces` raises `23503`.
  Move them first (`PATCH /api/packages/{scope}/{name}`). Any automation of
  yours that deletes spaces has to move homes first from now on. What will
  become undeletable, run AFTER `0014`:

  ```sql
  SELECT home_space_id AS space_id, count(*) AS homed_packages
  FROM packages
  WHERE home_space_id IS NOT NULL
  GROUP BY home_space_id
  ORDER BY homed_packages DESC;
  ```

- **`spaces.owner_user_id → user.id`.** A user who owns a personal space cannot
  be deleted. This codebase has no user hard-delete path (`grep -rn deleteUser`
  finds none), so nothing regresses; an operator's ad-hoc `DELETE FROM "user"`
  raises `23503` until that member's personal space is swept
  (`POST /api/spaces/{id}/sweep-now`, orphaned spaces only).

`0065` adds no such edge — `package_shares` cascades on both halves.

### 4. Pre-flight — how many spaces `0015` would create

Only if you intend to run `0015` (step 8). It inserts ONE `spaces` row per
membership:

```sql
SELECT count(*) AS members, count(DISTINCT org_id) AS orgs FROM org_members;
```

The commercial module counts spaces for nothing today, so there is no quota to
breach; the number matters to a self-hosted operator who has imposed a per-space
ceiling of their own. Skipping `0015` entirely is a supported choice.

### 5. Stop the platform, migrate, run `0014`, start

The `0008` shape, for the reason in step 2 — nothing serves traffic while the
column exists unbackfilled:

```sh
# stop the platform
# apply pending Drizzle migrations ONLY: 0063 + 0064 + 0065, one boot batch
docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
  -f - < scripts/migration/0014-packages-home-space-backfill.sql
# then bring the new version up
```

`0014` prints `no_home_before` split four ways, the ambiguous list, and
`no_home_after` — which must equal `no_home_and_installed_nowhere`, i.e. the
only packages left without a home are the ones installed nowhere.

### 6. Validate lot 0 — the home rule

- A builder who holds `<type>:write` in a package's home edits it while browsing
  a space where they only read.
- No caller sees "requires permission in every space where it is installed"
  (`grep` for it; the message is gone).
- `DELETE /api/spaces/{id}` on a space that homes a package answers
  `409 space_homes_packages` and lists their ids.
- An API key can write a package again — the one whose home is its own space.

### 7. Validate lot 1 — personal spaces

- `GET /api/spaces` for a member lists `personal: true` for exactly one space,
  and the org switcher pins it above the team spaces.
- An organization admin gets **404** on that space's detail, its members list,
  `PATCH`, `DELETE` and `convert-to-team` — not a 403, not a 409.
- `POST /api/api-keys` in a personal space answers
  `409 personal_space_takes_no_keys`; `POST /api/end-users` answers
  `409 personal_space_takes_no_end_users`.
- Removing a member stamps `spaces.orphaned_at` and the organization's Spaces
  page lists the orphan with **Convert** / **Sweep now**.

### 8. Run `0015` — later, and only if you want to

After step 7 passes. Nothing is degraded while it has not run: every membership
door creates the space, and `GET /api/spaces` repairs the caller's own. What it
buys is the members who will not log in soon — their space exists before someone
shares a package to them. Idempotent; a second run inserts zero rows and
`missing_personal_space_after` must print 0.

### Rollback — what is actually reversible

Per file, and they do not agree:

| File   | Before its script                            | After its script                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0063` | Safe. An older build never reads the column. | Serviceable — the old build still ignores the column — but `DELETE FROM spaces` now raises `23503` on a space that homes a package, and the old build has no route that clears a home. Run `UPDATE packages SET home_space_id = NULL` FIRST, before any space deletion. |
| `0064` | **Already one-way.**                         | Same. `0015` changes only HOW MANY personal spaces exist, never whether any do.                                                                                                                                                                                         |
| `0065` | Safe.                                        | Safe — no script. An older build never reads `package_shares`; the rows left behind are inert.                                                                                                                                                                          |

`0064` is one-way from the **first boot of the new build**, not from `0015`:
`provisionMember` creates a personal space at every membership door and
`GET /api/spaces` repairs the caller's own, so they exist from the first request
served. An older build's `resolveSpaceRole` does not read `owner_user_id` — it
reads such a space as an ordinary `private` one and hands every organization
owner and admin `admin` in it, which is the one thing §3.6 refuses — and its
`PATCH /api/spaces/{id}` can set `visibility`, which the CHECK
`spaces_personal_is_private` then refuses at the database as a 500. There is no
route that undoes it either: a LIVE personal space is convertible by nobody, by
design. A rollback therefore means an operator turning every one of them into a
team space by hand (`UPDATE spaces SET owner_user_id = NULL, orphaned_at = NULL
WHERE owner_user_id IS NOT NULL`) and accepting that what members kept private
becomes readable by the organization's admins. Restore the coordinated backup
instead where one exists, and prefer rolling forward.

## Duplicate model bindings (script `0013`, drizzle `0062`)

1. **Pre-flight, before any drizzle migration.** `0062` creates
   `uq_org_models_unaliased_binding`, so a database holding two un-aliased
   `org_models` rows for the same `(org_id, credential_id, model_id)` cannot take the batch —
   the `CREATE UNIQUE INDEX` raises 23505 and rolls every pending migration in
   the release back. Count them:

   ```sql
   SELECT count(*) FROM (
     SELECT org_id, credential_id, model_id
     FROM org_models
     WHERE aliased = false
     GROUP BY org_id, credential_id, model_id
     HAVING count(*) > 1
   ) d;
   ```

   Zero → nothing to do; go straight to the drizzle batch.

2. Non-zero → run `0013-org-models-dedupe-bindings.sql` BEFORE the drizzle
   batch. It keeps the oldest row of each binding, repoints
   `organizations.default_model_id`, `space_packages.model_id`,
   `package_schedules.model_id_override` and `llm_usage.model` at it, then
   deletes the younger copies — in one transaction, so no pointer is ever left
   naming a deleted row. Repointing the ledger is what re-consolidates the
   per-model spend the duplicates were splitting; the commercial module settles
   by serial id and never reads that column, so nothing about billing state
   moves.

3. Check `duplicate_bindings_after` prints 0 and all four `dangling_*` counts
   print 0, then apply the drizzle batch (step 4 of the RBAC rollout above,
   which is where this release's batch is enumerated).

4. From this release on, `POST /api/models` answers `409 model_already_added`
   (carrying `existing_model_id`) instead of minting a second row, and
   `PUT /api/models/{id}` answers the same when an edit would repoint a row onto
   a binding another row holds.

## Log

| #    | date        | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | 2026-08-26  | `files.id` `doc_` → `file_` and every reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 521 / 25 / 64 / 59                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0002 | 2026-08-26  | `chat_messages`: `document://file_` → `appfile://file_`, finishing 0001's write 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 59                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0003 | 2026-08-28  | `app_` → `spc_` space ids (+18 FK columns), `applications:*` scopes, `end_user:` realms, `level` vocabulary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 10750 id rows (33 `spaces` + 10717 across the 18 columns) / 32 scopes / 1+1 realms / 16 reasons / 1 `level`; 17 FKs dropped + restored                                                                                                                                                                                                                                                                                                                                                                                  |
| 0004 | not applied | oauth `resources` columns (0006) on a watermark-drifted DB — not rehearsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | unmeasured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 0005 | 2026-08-28  | AFPS `delivery.http.prefix`: bare auth scheme → separator-carrying (`"Bearer"` → `"Bearer "`), both manifest stores — **one deploy with the `integrationManifestSchema` (1d) gate**; run it FIRST, both spellings render alike under the old code                                                                                                                                                                                                                                                                                                                                                                    | 126 `package_versions` / 77 `packages.draft_manifest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 0007 | not applied | skills: quote the `description:` lines `yaml` cannot parse, so their drafts are savable again under the SKILL.md frontmatter gate — **run after deploying the gate**; `.ts`, dry-run by default, `--apply` to write                                                                                                                                                                                                                                                                                                                                                                                                  | 17 of 66 skills fixable, 3 need a manual edit (2 `name`, 1 over-long description) — counted on production, NOT rehearsed                                                                                                                                                                                                                                                                                                                                                                                                |
| 0008 | not applied | org role `viewer` → `guest` + an explicit `viewer` `space_members` row in every space that exists; pending invitations and legacy OAuth signup clients carry the same current-space snapshot — **run between drizzle `0056` and bringing the new version up**; viewers are locked out in between                                                                                                                                                                                                                                                                                                                     | unmeasured — the script prints before/after counts and aborts if any survives. This deployment ran it on nothing: production held 2 viewer members (2 orgs, 1 space each) and 2 accepted viewer invitations on 2026-09-09, moved off `viewer` by hand so the whole rollout could ship as one release — see step 3                                                                                                                                                                                                       |
| 0009 | not applied | `org_invitations`: cancel older duplicate pending rows per (org, email) so drizzle `0056` can create `uq_org_invitations_pending` — **run before the drizzle batch when the rollout pre-flight counts any**; a duplicate pair needs two creates that raced                                                                                                                                                                                                                                                                                                                                                           | unmeasured — prints the duplicate-pair count before/after, after must be 0                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 0010 | not applied | the commercial module's billing tables out of the database it used to run on and into the platform database, under the `drizzle.ee_migrations` journal — **run with the platform stopped, before deploying the release that moves the module in-tree**; the source prefix is detected and its level READ from its own journal (`cloud_*` at `0003` is production's), reads `EE_SOURCE_DATABASE_URL` + `DATABASE_URL`, `.ts`, dry-run by default, `--apply` to copy. A target the module has already booted against is NOT a problem: the watermark `init()` seeds in `ee_billing_cursor` is replaced by the source's | unmeasured — prints the per-table source/target counts and exits non-zero on any mismatch; refuses a mixed prefix, a source below `0003` or with no journal, an unknown `ee_`/`cloud_` table, a source-only column, or a target holding billing rows in any table but the seeded cursor (exit 1, nothing written), so a second `--apply` refuses rather than double-counting. That last refusal prints both sides' counts and never tells anyone to empty a database — the source is the only record of what was copied |
| 0011 | not applied | `oauth_clients.self_service` set from the `metadata` JSON key `selfService`, which drizzle `0057` leaves behind when it adds the column — **run after the drizzle batch**, which the API refuses to boot past until this has run; rows whose `metadata` is not valid JSON are skipped, not rewritten                                                                                                                                                                                                                                                                                                                 | unmeasured — prints the count it will fold before and after, after must be 0                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0012 | not applied | `org_invitations` reading `viewer` with a status other than `pending` — the history `0008` deliberately leaves alone — mapped to `guest`, so drizzle `0059` can recreate the type without the value; **run right after `0008`**                                                                                                                                                                                                                                                                                                                                                                                      | unmeasured — prints the history and pending counts before and after, history after must be 0                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0013 | not applied | `org_models`: keep the oldest un-aliased row per (org, credential, model), repoint `organizations.default_model_id` / `space_packages.model_id` / `package_schedules.model_id_override` / `llm_usage.model` at it and delete the younger copies, so drizzle `0062` can create `uq_org_models_unaliased_binding` — **run before the drizzle batch when the pre-flight above counts any**; a duplicate needs two `POST /api/models` for the same pair                                                                                                                                                                  | unmeasured — prints the duplicate-binding count before/after (after must be 0) and the four dangling-reference counts (all must be 0)                                                                                                                                                                                                                                                                                                                                                                                   |
| 0014 | not applied | every organization package given a `home_space_id` — its ONE write-authority space (drizzle `0063` adds the column NULL everywhere, i.e. admin-only): exactly one installation → that space, several → the oldest `installed_at` **printed for review before `COMMIT`**, none → left NULL; **run between the drizzle batch and bringing the new version up**, the `0008` shape; serving traffic in between costs every non-owner author and every API key write access to their own packages                | unmeasured — prints the NULL-home count before and after (after = the packages installed nowhere) and the ambiguous list in between                                                                                                                                                                               |
| 0015 | not applied | one personal space per existing `org_members` row (`spaces.owner_user_id`, drizzle `0064`) — **run AFTER the release is deployed and validated, never inside the window**: `provisionMember` creates them at every membership door and `GET /api/spaces` repairs the caller's own, so nothing is degraded while this has not run; what it buys is the members who do not log in soon. **Pre-flight the space count first** — it inserts one row per membership, and nothing counts spaces for a quota today | unmeasured — prints the membership count and the missing-personal-space count before and after; after must be 0                                                                                                                                                                                                   |
