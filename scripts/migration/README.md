# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
boot, and **never** live in `packages/db/drizzle/`.

See `docs/NO_TRANSITIONAL_CODE.md` for why the split exists — both halves of the
`documents` → `files` rename were botched by ignoring it, each costing a
production incident.

## Release beta.58 — shipped

**Filed as done, 2026-09-18.** This page carried that release's runbook in the
present imperative for as long as it was the next thing to happen. It has
happened: `ghcr.io/appstrate/appstrate:1.0.0-beta.58` is what production runs,
and a runbook kept past its window reads as live instruction to whoever opens
this file for the NEXT release. The runbook itself is in git history; what
survives here is the state it left, read back off production on 2026-09-18.

| Read back                            | Value                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| `drizzle.__drizzle_migrations`       | **68** rows — `0000` … `0067`, the whole pending batch  |
| `drizzle.ee_migrations`              | 8 — the commercial module's own journal, self-applied   |
| `ee_billing_accounts`                | 31, with 717 claimed ledger rows                        |
| `org_members` by role                | 31 owner / 16 admin / 1 member / **2 guest** / 0 viewer |
| `oauth_clients.self_service IS NULL` | 0                                                       |
| `packages_org_package_has_home`      | `convalidated = true`                                   |
| personal spaces                      | 6, against 50 memberships                               |

What that establishes, per script, without re-deriving it from a plan:

- **`0010` ran.** The commercial module's seven `ee_*` tables are in the
  platform database under their own journal, and 31 billing accounts came
  across. This was the one irreversible step of the release: `0010` is
  idempotent BY REFUSAL, so a target already holding billing rows is refused
  for good.
- **`0008` + `0012` + `0017` ran.** No row reads `viewer` and two read `guest`.
- **`0011` ran**, or had nothing to fold: no `oauth_clients` row is left NULL.
- **`0014` ran**, and validated `0067`'s `NOT VALID` check as it ends by doing.
  Every org package that is not `ephemeral` has a home.
- **`0009` and `0013` were not needed.** Their preconditions are the unique
  indexes `uq_org_invitations_pending` and `uq_org_models_unaliased_binding`,
  both of which exist — and the batch that creates them applies in ONE
  transaction, so it could not have committed had either pre-flight counted a
  duplicate.
- **`0015` has not run, by design.** It is the one step that belongs outside
  the window: `provisionMember` creates a personal space at every membership
  door and `GET /api/spaces` repairs the caller's own, so what `0015` buys is
  the members who do not log in soon. 6 of 50 exist because 6 members have been
  through a door since. Pre-flight the space count before running it.

**What it owed, and no longer does: `0068`.** Production never waited on it —
`0014` validated `0067`'s check there. A FRESH install did, since the drizzle
tree alone never validates it. `0068_packages_org_home_validate.sql` shipped in
`v1.0.0-beta.59` (#1467) and closes it; the reasoning, and why it could not ride
in beta.58's own batch, is under **Shipped in the follow-up release** below.

The per-subject sections below are not runbooks and never were. They explain
what each script does and what it checks, which is what the next release reads
them for.

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

## Detail — RBAC rollout (drizzle `0056` + `0059`, scripts `0008` + `0009` + `0012` + `0017`)

**Not a runbook.** The order lives in "Release beta.58" above: these files are its
before the drizzle batch (`0009`) and after it (`0008`, `0012`, `0017`). What follows is what
each one is for and which query decides whether it has work.

One thing to confirm on the rehearsal copy before anything else: every
organization that has chat sessions has a default space, because `0056` promotes
`chat_sessions.space_id` to NOT NULL and folds existing sessions onto that space.

1. **Pre-flight — duplicate pending invitations.** `0056` creates
   `uq_org_invitations_pending`; a pre-existing duplicate pending pair makes that
   `CREATE UNIQUE INDEX` raise 23505, which rolls the whole twelve-migration
   transaction back and fails the deploy. Count the pairs first:

   ```sql
   SELECT count(*) FROM (
     SELECT org_id, email FROM org_invitations
     WHERE status = 'pending' GROUP BY org_id, email HAVING count(*) > 1
   ) d;
   ```

   Non-zero → run `0009-org-invitations-dedupe-pending.sql` before the drizzle batch of the
   runbook, and re-run the query until it prints 0. Measured 2026-09-17: **0**.

2. **Pre-flight — the four `viewer` counts.** `0059` recreates `org_role` without
   `viewer`, and nothing can run between `0056` and it: drizzle applies the whole
   pending batch in one transaction and the row scripts run after it. This query
   is `0059`'s own guard run by hand:

   ```sql
   SELECT
     (SELECT count(*) FROM org_members     WHERE role::text = 'viewer')                        AS members,
     (SELECT count(*) FROM org_invitations WHERE role::text = 'viewer' AND status =  'pending') AS pending,
     (SELECT count(*) FROM org_invitations WHERE role::text = 'viewer' AND status <> 'pending') AS history,
     (SELECT count(*) FROM oauth_clients   WHERE signup_role = 'viewer')                        AS clients;
   ```

   Every comparison is `::text` on purpose, and so is every one inside `0008`,
   `0012` and `0017`. After `0059` the literal `'viewer'` no longer parses as an
   `org_role`, and Postgres casts it BEFORE comparing — so a bare
   `role = 'viewer'` raises `22P02` even against zero rows. `0059`'s own
   "WHY THE COMPARISONS ARE `::text`" section is the authority. This matters
   precisely because the scripts run AFTER the batch that carries `0059`.

   **Four zeros** (measured 2026-09-17) → `0008` and `0012` match nothing. Run
   them anyway, at step 4, as witnesses: their counts discriminate and `0012`
   additionally proves `0008` ran. Do **not** conclude there is nothing to
   repair — see `0017` below.

   **`members`, `pending` or `history` non-zero** → `0008` must READ `viewer` to
   compute the `space_members` rows that preserve those users' reach, and it
   cannot run before `0056` creates that table. That sandwich needs a release
   that carries `0056` without `0059`, which is a FUTURE release nobody has cut:
   since beta.57 the twelve migrations are all unapplied and ship as one
   transaction. On this database the counts are zero and the question is moot;
   read "Why there is no 'two releases' branch" in the runbook before reviving
   it.

   **`clients` non-zero** → a different fault, and no script clears it. `0056`
   section G is what flips `oauth_clients.signup_role`, and it validated a
   narrowed CHECK on its way out, so a surviving `viewer` means `0056` never
   applied here. Check the `drizzle.__drizzle_migrations` watermark — a corrupted
   one makes the migrator report nothing pending (see
   `0004-oauth-resources-watermark-drift.sql`) — before anything else.

3. **`0008-org-viewer-to-guest.sql`** snapshots memberships, pending viewer
   invitations and legacy OAuth viewer signup clients into explicit `viewer`
   grants, preserving any existing explicit role choices. Reruns do not add later
   spaces: a run that commits records itself in `drizzle.migration_scripts`, and
   every later run skips `0008`'s own step 4 (the OAuth signup snapshot)
   outright — naming the OAuth signup clients whose empty snapshot its predicate
   still matches, and which it would otherwise have widened. Re-running that step
   on purpose means deleting the marker row by hand. It aborts if any captured
   membership, invitation or OAuth signup space is missing; inspect the legacy
   OAuth snapshots against the rehearsal's pre-migration client/space inventory.

4. **`0012-org-invitation-history-viewer-to-guest.sql`** takes what `0008`
   deliberately leaves: `0008` restricts itself to `status = 'pending'`
   invitations, because only those owe a `space_assignments` snapshot; `0012`
   maps the accepted, expired and cancelled ones — pure history — to `guest`,
   which `0059` needs since it cannot cast them.

5. **`0017-restore-handmoved-viewers.sql`** is the one with work to do here, and
   it is invisible to the query in point 2. On 2026-09-09 the two `viewer`
   members this database held were moved off the value **by hand**, to `member`,
   because `guest` did not exist in the type yet — `0056` section A is what adds
   it, and `0056` has never applied on production. `member` is strictly wider
   than what they had: with `spaces.default_role = 'operator'` it is write access
   in every open space of their organization, from the first boot of the new
   build. `0008` cannot catch it — it selects `WHERE role::text = 'viewer'`,
   which is now the empty set — so it runs green over those two rows and leaves
   them as they are.

   `0017` gives them the shape `0008` would have: one `space_members` row with
   `preset_role = 'viewer'` per TEAM space of their organization, then `member` →
   `guest`, and only while the row still reads `member`, so a decision taken
   since 2026-09-09 is left alone and named rather than overwritten. The two
   pairs are literals in the file; its header carries the standalone re-check and
   the rollback.

   This is the general rule, not a one-off: **moving rows off `viewer` by hand is
   a supported way to collapse the two-release sandwich, and it always owes a
   restore.** `guest` reaches nothing without an explicit `space_members` row,
   which is exactly what `0008` writes for a real `viewer` and what `0017` writes
   for a hand-moved one. The restore belongs in the same window as the rest, not
   in a follow-up.

## Detail — OAuth-provider 1.7.3 rollout (drizzle `0057`, script `0011`)

**Not a runbook.** `0011` is step 4 of "Release beta.58"; the pre-flight below is
its pre-flight, and it is the one that cannot wait for the window.

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

2. **`0057_oauth_provider_1_7_3.sql`** is part of the twelve-migration batch
   (the release's one drizzle batch), not a batch of its own. Its section D drops
   `oauth_clients.public` and `type`; an older build still serving inserts
   clients with those columns and fails 42703, so roll forward rather than
   leaving both builds live.

3. **`0011-oauth-clients-self-service-fold.sql`.** `0057` adds
   `oauth_clients.self_service` as `false` everywhere; this sets it from the
   `metadata` JSON key `selfService`. Until it runs, every self-registered
   client reads as operator-provisioned and `/oauth2/token` does not confine its
   tokens to one protected resource.

   **The API refuses to boot until it has run**
   (`assertSelfServiceFoldApplied`, `apps/api/src/lib/boot.ts`): it counts the
   rows still unfolded and exits naming this file, and under a supervisor it
   restarts into the same refusal. The runbook's order is what makes that
   refusal never fire — `0011` is step 4, the application starts at step 5. A
   deployment that lets the platform boot first meets the refusal instead, and
   the fix is the same script followed by a restart. A deployment that never
   accepted a self-registered client counts zero and never sees it either way.

4. Check the script's `to_fold_after` prints 0 and `self_service_after` grew by
   `to_fold_before`. A non-zero `unparseable_metadata` is a manual read of those
   rows, not a failure.

## Detail — Personal spaces & sharing rollout (drizzle `0063` … `0067`, scripts `0014` + `0016` + `0015`)

**Not a runbook.** `0014` and `0016` are step 4 of "Release beta.58", in that
order; `0015` is its step 7. What is below is the reasoning, the pre-flights and
the validation lists the runbook points at.

These five migrations are NOT a batch of their own: production's watermark is
`0055`, so they arrive inside the same twelve-migration transaction as `0056` …
`0062`. Nothing here needs a new environment variable — `TRUST_PROXY` and
`MODULES` are owed by the release's own configuration steps, not by these files.

`0016` is second because it reads what `0014` writes. It gives every
`space_packages` row that sits outside its package's home the `package_shares`
row that now places it there: from this release on, a package is readable from a
space through its HOME or through a share and through nothing else, so a row
left without one vanishes from the space that runs it — invisible on every page,
refused by the run doors and by the scheduler tick — until somebody holding
`share` authority offers it again.

`0016` repairs what INHERITED data left, and that is the whole of its job: **the
new code manufactures no such rows.** The two paths that rewrite a package's home
— `PUT /api/packages/{scope}/{name}/home` and the personal-space offboarding sweeper
— both write the offers that keep every other space placed, from one shared
function and inside their own transaction. So this script runs once, in this
window, and nothing accumulates behind it: a second run inserts nothing, and a
`without_share_after` that drifts off 0 after the deploy is a bug, not a backlog.

Read the header of each file too — it is the authority on what that file touches.

### 1. Rehearse

Take the release's pre-flight dump, restore it into a throwaway
`postgres:16-alpine` and run the whole drizzle batch and every operator script
of the release against it, not just these three
files. Record the counts; production volume is UNMEASURED for all three scripts
until this is done.

Synthetic rehearsal (2026-09-11): `apps/api/test/integration/db/personal-spaces-backfill.test.ts` executes all three files unchanged on PGlite and PostgreSQL 16. The home fixture covers one installation, multiple installations, no installation, an operator move and replay; the share fixture covers an installation outside its home, one inside it, a system package, a cross-tenant stray row, the ordering guard that makes `0016` abort when `0014` has not run, and replay; the personal-space fixture covers live membership, an orphan and replay. These tests validate behavior, not production volume or lock duration.

### 2. Pre-flight — which packages `0014` has to guess about

`0063` adds `packages.home_space_id` NULL on every row, and `0067` adds the CHECK
`packages_org_package_has_home` as `NOT VALID`: from the moment it applies, every
WRITE has to give an organization package a home, while the rows already in the
table still have none. Between the migrations and `0014` no organization package
has a home, so every non-owner author and **every API key** is locked out of its
own packages — which is why the runbook stops traffic at its step 2 and does not
start it again until `0014` and `0016` have both run. `0014` then picks a home per
package: one installation → that space, several → the OLDEST `installed_at`,
none → the organization's DEFAULT space (`spaces.is_default`). Its last statement
validates the constraint.

A package nobody installed therefore lands on the default space rather than
staying homeless. That is the rule, not a fallback: a package of the organization
that belongs to no team is the organization's, and the default space is where the
organization's own packages live. Owners and admins reached it already; a builder
of the default space gains the write, which is what a default space is for.

Only the "several" case is a guess. Count them on the replica (`ssh appstrate`).
The column does not exist yet there, so these run WITHOUT `0014`'s own "has no
home yet" clause — before the migration every row qualifies:

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
afterwards with `PUT /api/packages/{scope}/{name}/home {"home_space_id": …}` —
the id is REQUIRED and shape-checked (`spc_` + UUID), `null` is a 400, and a
PERSONAL space as destination is a `409 home_move_into_personal_space`. There is
no `PATCH` on that path: the package itself is read and written at
`/api/packages/{type}/{scope}/{name}`, and `home` is an act hanging off the
untyped one.

`0014` prints a SECOND review block right after it — the organizations that own
a package and have **no default space**. It must be empty. The third case has
nowhere to put those rows, so the closing `VALIDATE CONSTRAINT` would abort the
whole transaction; the fix is an operator's, not the script's: give the
organization a default space (`spaces.is_default`) and re-run. Every
organization the platform provisioned has one, so a non-empty block means a
hand-made org. Count it on the replica the same way:

```sql
SELECT p.org_id, count(*) AS homeless_packages
FROM packages p
WHERE p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND NOT EXISTS (
    SELECT 1 FROM spaces s WHERE s.org_id = p.org_id AND s.is_default
  )
GROUP BY p.org_id
ORDER BY p.org_id;
```

### 3. Pre-flight — what the two `RESTRICT`s make undeletable

`0063` and `0064` each add an `ON DELETE RESTRICT` edge, and both are deliberate
refusals rather than cascades. Know what they will refuse:

- **`packages.home_space_id → spaces.id`.** After `0014`, a space that homes a
  package cannot be deleted: the API answers `409 space_homes_packages` and
  names the packages, and a hand-written `DELETE FROM spaces` raises `23503`.
  Move them first (`PUT /api/packages/{scope}/{name}/home`). Any automation of
  yours that deletes spaces has to move homes first from now on. Note that
  `0014` homes every package installed nowhere on the organization's DEFAULT
  space, so that space appears in the list below for every organization that had
  one such package — which changes nothing operationally, since
  `DELETE /api/spaces/{id}` already refuses a default space outright. What will become undeletable, run AFTER `0014`:

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

Only if you intend to run `0015`, which comes after the release is deployed
and validated, never inside the window. It inserts ONE `spaces` row per
membership:

```sql
SELECT count(*) AS members, count(DISTINCT org_id) AS orgs FROM org_members;
```

The commercial module counts spaces for nothing today, so there is no quota to
breach; the number matters to a self-hosted operator who has imposed a per-space
ceiling of their own. Skipping `0015` entirely is a supported choice.

### 5. What `0014` and `0016` print — inside the window, after the drizzle batch

Both run with the platform stopped, `0014` first, for the reason in step 2:
nothing may serve traffic while `home_space_id` exists unbackfilled, and nothing
may serve traffic while installations outside their home have no share placing
them. The four other scripts that share the window are listed under **Release
beta.58** above — there is no separate stop-migrate-start here, and the drizzle
batch this pair follows is the release's whole pending set, not `0063`–`0067`.

`0014` prints `no_home_before` split four ways, the ambiguous list, and
`no_home_after` — **which must be 0**: every organization package now has a home,
the ones installed nowhere included, since those went to the default space. Its
last statement is
`ALTER TABLE packages VALIDATE CONSTRAINT packages_org_package_has_home`, which
turns `0067`'s `NOT VALID` into a checked invariant; it raises `23514` instead of
committing if a row was missed, and on a fresh database it has nothing to walk
and is a healthy no-op. That statement runs under `SET LOCAL statement_timeout =
0` — it is a full scan of `packages` on an unmeasured table, and the file's 60s
ceiling would have aborted the whole transaction, backfill included, on a
timeout error that names no statement. Both halves stay replayable as they are.
The order is unchanged: migrations, then `0014`, then `0016`.

`0016` prints `installed_outside_home_before` and `without_share_before`, then
`without_share_after` — **which must be 0**. The order is load-bearing: it
compares each installation against `packages.home_space_id`, and against a NULL
home that comparison is NULL, so a run before `0014` would match nothing, write
nothing, and print `0` twice — green, and useless. It therefore opens with a
guard that counts the organization packages still without a home and raises
`0016 requires 0014 first` rather than let that happen. Both files are
idempotent; a second run of either inserts nothing.

### 6. Validate lot 0 — the home rule and the placement rule

- A builder who holds `<type>:write` in a package's home edits it while browsing
  a space where they only read.
- A builder of space B who holds no `<type>:share` in space A cannot activate
  A's package in B: **403** when they can otherwise read it, **404** when they
  cannot. An organization admin activates that same package in B and the
  `package_shares` row appears with it, written in the same transaction.
- Activating a package that is already active answers **200**, not a conflict,
  and `DELETE /api/spaces/{id}/packages/{scope}/{name}` answers **204** and
  leaves the row: read `model_id` back after a deactivate/reactivate round trip
  and it is the one the space chose. The status reports what the CALL did, so
  switching a package back ON after a deactivation answers **201**.
- `DELETE` on an offer nobody has activated answers **404** and leaves it a
  pending offer: the library still shows the row as **Proposé**, not as
  switched off.
- A package id the caller cannot reach — one homed in another member's personal
  space — answers the SAME 404 body as an id that does not exist, on all three
  doors (`POST`, `PUT`, `DELETE`). Compare the two responses field by field;
  they must be identical. `POST /api/runs/remote` answers the same way for a
  package no placement holds in the calling space, and answers
  `package_not_active_in_space` only for one the space holds and has switched
  off — compare those two bodies field by field as well.
- **Every organization package has a home**, the system and ephemeral rows
  apart — the invariant `0067` enforces and `0014` validated:

  ```sql
  SELECT count(*) AS packages_without_home
  FROM packages
  WHERE org_id IS NOT NULL AND NOT ephemeral AND home_space_id IS NULL;
  ```

  It must print **0**, and it cannot become anything else afterwards: a write
  that tried raises `23514`. A non-zero here means `0014` did not run or did not
  commit — go back to step 5 rather than patching rows by hand.

  **This count is THE signal, not `pg_constraint.convalidated`.** That flag says
  only whether somebody ran a `VALIDATE`: a freshly installed deployment has
  never run `0014`, so it reads `false` there for ever while the constraint
  governs every write exactly as it does on a migrated one. Reading it across a
  fleet compares installation histories, not states.

- A SYSTEM package can be switched off in a space and stays off: `DELETE`
  answers 204 and writes the row, the space's library reads the row as
  **Désactivé**, `GET /api/agents` stops listing it, and the next `POST`
  switches it back on.
- An integration is activated through the same pair of doors as every other
  type, and `PUT /api/spaces/{id}/packages/{scope}/{name}` accepts `modelId`,
  `proxyId` and `generationConfig` and nothing else — any other field is a 400.
- Every package a team space was running before the deploy is still listed
  there — that is `0016`'s whole job, and `without_share_after = 0` is its
  machine-checkable half.
- No caller sees "requires permission in every space where it is installed"
  (`grep` for it; the message is gone).
- `DELETE /api/spaces/{id}` on a space that homes a package answers
  `409 space_homes_packages` and lists their ids.
- An API key can write a package again — the one whose home is its own space. A
  builder of the default space, AND an API key pinned to the default space
  carrying `<type>:write`, both write the packages homed at the default: that is
  what the default space is for, and it is the population the previous rule
  excluded by name.

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
- **Sweep now** on an orphaned space that homes a package a TEAM space is
  running re-homes it to the organization's **default space** and
  **writes the offer that keeps that team space placed**: `GET …/shares`
  lists the team space with no author, the team's index, detail, run and
  schedules keep working, and re-running `0016`'s own `without_share_after`
  query (the `-- VERIFY (after)` block at the foot of the file) still prints
  **0**. The default space gets no offer — it is the home now — and the package,
  its draft included, becomes readable there, which is what "a package of the
  organization that belongs to no team" means. A package the orphaned space
  homed that NO other space was PLACED for — no offer and no installation — is
  deleted; an outstanding offer SAVES it, because a space that was shown the
  package can see it and the package was therefore never private.
- A package shared with a member shows up on THEIR space's library page as a
  placement with `via: "shared"` and `state: "none"` — a **Proposé** row with its
  own switch — and `POST /api/spaces/{personal}/packages` activates it with no
  activation grant at all: ownership is the authorization. Both library shapes
  answer with `placements` and nothing beside it.
- A `viewer` in a space where an agent is placed but switched OFF cannot run it.
  `GET /api/agents` does not list it — an index is the ACTIVE set — while
  **Packages de cet espace** shows it as **Désactivé** with its switch, and the
  THREE execution doors — `POST /api/agents/{scope}/{name}/run` (a rerun is the
  same route), `POST …/schedules` and `GET …/bundle` — answer
  **404 `agent_not_active_in_space`**, naming the space and
  `POST /api/spaces/{id}/packages`.
- That same agent READS normally, which is what makes it repairable. Its detail
  answers **200** with `active: false`, and so do `GET …/model`, `/proxy`,
  `/persistence`, `/runs`, `/schedules` and the writes beside them. Open it in
  the SPA from the library row (or from its URL directly): the page opens
  without an error, carries the one-line **Désactivé dans cet espace** banner
  with an **Activer** button, and one click reopens the three doors. An offer
  nobody has taken up reads **Proposé** on that same library page and appears on
  no index. `GET …/connection-readiness` answers **200**
  too, with `blocks_run: true` and an `errors[0]` whose `field` is `agent` and
  whose `code` is `agent_not_active` — a 404 there would blank the panel that
  explains the refusal.
- **The index lists what the space can LAUNCH; the library lists what is
  PLACED.** Switch an agent off and it leaves the **Agents** page and the run
  and schedule pickers on the spot, and stays on **Packages de cet espace**;
  switch it back on there and it returns to the index. The **Intégrations** page
  has no Actives / Toutes tabs — the library is the other half — and an empty
  index names the library rather than pretending the space holds nothing.
- `appstrate skills sync` writes only the skills a space has ACTIVE. Switch a
  skill off in a space, sync again, and its directory disappears from the target;
  switch it back on and the next sync restores it.
- A SCHEDULE on a switched-off agent creates a **visible failed run** naming the
  switch, and the schedule stays **armed** (`enabled = true`, `next_run_at` set)
  — switching the agent back on lets the next tick run it, with nothing to
  re-enable by hand.
- A `viewer` or an `operator` launching with `version=draft` gets
  **403 `draft_not_writable`**; the same person with the selector omitted runs
  the latest published version, and gets **404 `no_published_version`** when the
  agent has none. Publishing a new version changes what every recipient runs on
  their next launch, with nothing to accept again.

### 8. Run `0015` — later, and only if you want to

Runbook step 7, after its step 6 passes — never inside the window. Nothing is
degraded while it has not run: every membership
door creates the space, and `GET /api/spaces` repairs the caller's own. What it
buys is the members who will not log in soon — their space exists before someone
shares a package to them. Idempotent; a second run inserts zero rows and
`missing_personal_space_after` must print 0.

### Shipped in the follow-up release — `0068 … VALIDATE CONSTRAINT`

`0067` adds `packages_org_package_has_home` `NOT VALID`, and `0014` — an
operator script — is what validates it, so the drizzle tree by itself never did:
a fresh install, where `0014` never runs, kept
`pg_constraint.convalidated = false` for ever, and
`docs/NO_TRANSITIONAL_CODE.md` §2's pattern (`ADD … NOT VALID` in one migration,
`VALIDATE` in a later one) was left half-written. It could not be closed in THIS
release: the batch applies every pending migration, `0067` included, BEFORE
the operator scripts run — so a `VALIDATE` inside that batch would have scanned
`packages` while every `home_space_id` was still NULL, raised `23514` and rolled
the whole transaction back, the deploy failing on the very migration meant to
confirm it. **The shape recurs**: when a constraint's precondition is an
operator script that runs after the batch, its `VALIDATE` belongs in the NEXT
release, never in the one that adds the constraint.

**It shipped** as `packages/db/drizzle/0068_packages_org_home_validate.sql` in
`v1.0.0-beta.59`, one statement —
`ALTER TABLE "packages" VALIDATE CONSTRAINT "packages_org_package_has_home";`.
Where `0014` has committed it is a no-op: production, read read-only on
2026-09-18, already carries `pg_constraint.convalidated = true`, and the
statement itself was rehearsed there inside a transaction that was then rolled
back, which succeeded. Its real job is the fresh-install path, where `0014`
never runs and the constraint would otherwise stay `NOT VALID` for ever; on a
deployment that somehow skipped `0014` it fails loudly with `23514` — the
intended failure, not an accident.

**Where this is recorded.** In `0067`'s own header, under "THE REMAINING HALF",
the way `0056` records its `viewer` window, and in `0068`'s header, which
carries the closing half. Neither is to be edited now that the debt is paid: a
shipped migration is never rewritten, and the reasoning those two headers carry
is what the next reader of this shape needs. Issue #1450 is closed by
`v1.0.0-beta.59`; this page is not the record — it is a release runbook, and a
runbook gets filed as done.

### Rollback — what is actually reversible

Per file, and they do not agree:

| File   | Before its script                                                                                                                                                                                   | After its script                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0063` | Safe. An older build never reads the column.                                                                                                                                                        | Serviceable — the old build still ignores the column — but `DELETE FROM spaces` now raises `23503` on a space that homes a package, and the old build has no route that clears a home. Clearing the homes means dropping `0067`'s CHECK first — `ALTER TABLE packages DROP CONSTRAINT packages_org_package_has_home;` then `UPDATE packages SET home_space_id = NULL`, in that order and before any space deletion. The reverse order raises `23514`. |
| `0064` | **Already one-way.**                                                                                                                                                                                | Same. `0015` changes only HOW MANY personal spaces exist, never whether any do.                                                                                                                                                                                                                                                                                                                                                                       |
| `0065` | Safe.                                                                                                                                                                                               | Safe — no script. An older build never reads `package_shares`; the rows left behind are inert.                                                                                                                                                                                                                                                                                                                                                        |
| `0066` | **One-way.**                                                                                                                                                                                        | Same. It DROPs `space_packages.version_id`, which a previous build reads at launch, on the detail page and in the export, and writes through the space-package configuration route. Whatever the column held is discarded with it. Restore the coordinated backup, or roll forward.                                                                                                                                                                   |
| `0067` | **Roll it back with the build.** The CHECK governs every write from the moment it applies, and an older build still creates organization packages with no home — each such `INSERT` raises `23514`. | Same. `ALTER TABLE packages DROP CONSTRAINT packages_org_package_has_home;` is the whole rollback and rewrites no row; `0014`'s `VALIDATE CONSTRAINT` leaves nothing else behind.                                                                                                                                                                                                                                                                     |
| `0016` | n/a — it is a script, not a migration.                                                                                                                                                              | Additive and inert for an older build: the extra `package_shares` rows are invisible to a build from before `0065` and read as ordinary offers by any build after it. Leaving them in place costs nothing, so there is nothing to undo.                                                                                                                                                                                                               |

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

## Detail — Duplicate model bindings (script `0013`, drizzle `0062`)

**Not a runbook.** The count below belongs to the release's pre-flight; `0013`,
if it is needed at all, runs with the platform stopped and before the batch.

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

2. Non-zero → run `0013-org-models-dedupe-bindings.sql` with the platform
   stopped, BEFORE the drizzle batch. It keeps the oldest row of each binding, repoints
   `organizations.default_model_id`, `space_packages.model_id`,
   `package_schedules.model_id_override` and `llm_usage.model` at it, then
   deletes the younger copies — in one transaction, so no pointer is ever left
   naming a deleted row. Repointing the ledger is what re-consolidates the
   per-model spend the duplicates were splitting; the commercial module settles
   by serial id and never reads that column, so nothing about billing state
   moves.

3. Check `duplicate_bindings_after` prints 0 and all four `dangling_*` counts
   print 0, then go on to the drizzle batch, which applies every pending migration
   in one transaction, `0062` among them.

4. From this release on, `POST /api/models` answers `409 model_already_added`
   (carrying `existing_model_id`) instead of minting a second row, and
   `PUT /api/models/{id}` answers the same when an edit would repoint a row onto
   a binding another row holds.

## Detail — Credentials of departed members (script `0019`)

**Not a runbook.** From the leave-organization release on, every exit — a
removal or a leave — revokes, in its own transaction (`removeMemberInTx`), the
member's API keys in the organization and the OAuth tokens that grant only that
organization. `0019` repairs the members who left BEFORE it: their credentials
were inert only because every reader joins `org_members`, and they revived the
moment the person was re-invited.

What it revokes — `revoked_at` / `revoked` = now(), only where NULL, for a user
who is no longer a member of the organization concerned:

- `api_keys` whose creator has no `org_members` row in the key's organization
  (a key whose creator was deleted, `created_by` NULL, is left alone);
- `oauth_refresh_tokens` / `oauth_access_tokens` of an org-level client
  (`oauth_clients.level = 'org'`) of that organization;
- the same tables' rows whose `resources` holds the organization's MCP resource
  URI, `<APP_URL>/api/mcp/o/<org_id>` — so `APP_URL` is passed as the psql
  variable `app_url`, exactly as the platform runs with it (the script refuses
  anything that is not `scheme://host[:port]`).

Only opaque tokens are rows: a JWT access token is not stored and stays valid
until its TTL, the per-request membership check being what stops it.

Run it once, after the release is deployed; the header carries the invocation
and a read-only pre-flight count. It prints the three counts before, and aborts
if any captured row is left unrevoked after. Idempotent without a marker: the
capture predicate is the condition the write removes.

## Log

| #    | date                | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0001 | 2026-08-26          | `files.id` `doc_` → `file_` and every reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 521 / 25 / 64 / 59                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 0002 | 2026-08-26          | `chat_messages`: `document://file_` → `appfile://file_`, finishing 0001's write 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 59                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 0003 | 2026-08-28          | `app_` → `spc_` space ids (+18 FK columns), `applications:*` scopes, `end_user:` realms, `level` vocabulary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 10750 id rows (33 `spaces` + 10717 across the 18 columns) / 32 scopes / 1+1 realms / 16 reasons / 1 `level`; 17 FKs dropped + restored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 0004 | not applied         | oauth `resources` columns (0006) on a watermark-drifted DB — not rehearsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | unmeasured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 0005 | 2026-08-28          | AFPS `delivery.http.prefix`: bare auth scheme → separator-carrying (`"Bearer"` → `"Bearer "`), both manifest stores — **one deploy with the `integrationManifestSchema` (1d) gate**; run it FIRST, both spellings render alike under the old code                                                                                                                                                                                                                                                                                                                                                                         | 126 `package_versions` / 77 `packages.draft_manifest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0007 | not applied         | skills: quote the `description:` lines `yaml` cannot parse, so their drafts are savable again under the SKILL.md frontmatter gate — **run after deploying the gate**; `.ts`, dry-run by default, `--apply` to write                                                                                                                                                                                                                                                                                                                                                                                                       | 17 of 66 skills fixable, 3 need a manual edit (2 `name`, 1 over-long description) — counted on production, NOT rehearsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 0008 | 2026-09-17          | org role `viewer` → `guest` + an explicit `viewer` `space_members` row in every space that exists; pending invitations and legacy OAuth signup clients carry the same current-space snapshot — **run between drizzle `0056` and bringing the new version up**; viewers are locked out in between                                                                                                                                                                                                                                                                                                                          | unmeasured — the script prints before/after counts and aborts if any survives. This deployment ran it on nothing: production held 2 viewer members (2 orgs, 1 space each) and 2 accepted viewer invitations on 2026-09-09, moved off `viewer` by hand so the whole rollout could ship as one release — see step 3. **Ran in the beta.58 window.** Read back 2026-09-18: 0 `viewer`, 2 `guest` — the end state this file shares with `0012` and `0017`; the per-script counts it printed were not captured                                                                                                                                                                                                    |
| 0009 | not needed          | `org_invitations`: cancel older duplicate pending rows per (org, email) so drizzle `0056` can create `uq_org_invitations_pending` — **run before the drizzle batch when the rollout pre-flight counts any**; a duplicate pair needs two creates that raced                                                                                                                                                                                                                                                                                                                                                                | unmeasured — prints the duplicate-pair count before/after, after must be 0. **Not run.** Its precondition, `uq_org_invitations_pending`, exists — and the batch that creates it applies in ONE transaction, so it could not have committed had the pre-flight counted a duplicate                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0010 | 2026-09-17          | the commercial module's billing tables out of the database it used to run on and into the platform database, under the `drizzle.ee_migrations` journal — **run with the platform stopped, before deploying the release that moves the module in-tree**; the source prefix is detected and its level READ from its own journal (`cloud_*` at `0003` is production's), reads `EE_SOURCE_DATABASE_URL` + `DATABASE_URL`, `.ts`, dry-run by default, `--apply` to copy. A target the module has already booted against is NOT a problem: the watermark `init()` seeds in `ee_billing_cursor` is replaced by the source's      | unmeasured — prints the per-table source/target counts and exits non-zero on any mismatch; refuses a mixed prefix, a source below `0003` or with no journal, an unknown `ee_`/`cloud_` table, a source-only column, or a target holding billing rows in any table but the seeded cursor (exit 1, nothing written), so a second `--apply` refuses rather than double-counting. That last refusal prints both sides' counts and never tells anyone to empty a database — the source is the only record of what was copied. **Ran in the beta.58 window**, and it is the release's one irreversible step. Read back 2026-09-18: `drizzle.ee_migrations` at 8, 31 `ee_billing_accounts`, 717 claimed ledger rows |
| 0011 | 2026-09-17          | `oauth_clients.self_service` set from the `metadata` JSON key `selfService`, which drizzle `0057` leaves behind when it adds the column — **run after the drizzle batch**, which the API refuses to boot past until this has run; rows whose `metadata` is not valid JSON are skipped, not rewritten                                                                                                                                                                                                                                                                                                                      | unmeasured — prints the count it will fold before and after, after must be 0. **Ran, or had nothing to fold.** Read back 2026-09-18: 0 `oauth_clients` rows left NULL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0012 | 2026-09-17          | `org_invitations` reading `viewer` with a status other than `pending` — the history `0008` deliberately leaves alone — mapped to `guest`, so drizzle `0059` can recreate the type without the value; **run right after `0008`**                                                                                                                                                                                                                                                                                                                                                                                           | unmeasured — prints the history and pending counts before and after, history after must be 0. **Ran in the beta.58 window.** Read back 2026-09-18: 0 rows read `viewer`, in history or pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 0013 | not needed          | `org_models`: keep the oldest un-aliased row per (org, credential, model), repoint `organizations.default_model_id` / `space_packages.model_id` / `package_schedules.model_id_override` / `llm_usage.model` at it and delete the younger copies, so drizzle `0062` can create `uq_org_models_unaliased_binding` — **run before the drizzle batch when the pre-flight above counts any**; a duplicate needs two `POST /api/models` for the same pair                                                                                                                                                                       | unmeasured — prints the duplicate-binding count before/after (after must be 0) and the four dangling-reference counts (all must be 0). **Not run.** Its precondition, `uq_org_models_unaliased_binding`, exists, and the batch is one transaction — same argument as `0009`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 0014 | 2026-09-17          | every organization package given a `home_space_id` — its ONE write-authority space (drizzle `0063` adds the column NULL everywhere, i.e. admin-only): exactly one installation → that space, several → the oldest `installed_at` **printed for review before `COMMIT`**, none → the organization's DEFAULT space (drizzle `0067` forbids a homeless organization package, and `0014` ends by `VALIDATE`ing that check); **run between the drizzle batch and bringing the new version up**, the `0008` shape; serving traffic in between costs every non-owner author and every API key write access to their own packages | unmeasured — prints the NULL-home count before and after (after must be **0**) and the ambiguous list in between. **Ran in the beta.58 window.** Read back 2026-09-18: `packages_org_package_has_home` is `convalidated = true`, which `0014` is what does, so every org package that is not `ephemeral` has a home                                                                                                                                                                                                                                                                                                                                                                                          |
| 0015 | not run — by design | one personal space per existing `org_members` row (`spaces.owner_user_id`, drizzle `0064`) — **run AFTER the release is deployed and validated, never inside the window**: `provisionMember` creates them at every membership door and `GET /api/spaces` repairs the caller's own, so nothing is degraded while this has not run; what it buys is the members who do not log in soon. **Pre-flight the space count first** — it inserts one row per membership, and nothing counts spaces for a quota today                                                                                                               | unmeasured — prints the membership count and the missing-personal-space count before and after; after must be 0. **Deliberately outstanding.** Read back 2026-09-18: 6 personal spaces against 50 memberships, the 6 created by `provisionMember` at a membership door rather than by this script. Pre-flight the space count before running it                                                                                                                                                                                                                                                                                                                                                              |
| 0016 | 2026-09-17          | one `package_shares` row (`shared_by` NULL) per `space_packages` row sitting outside its package's home, so the placement rule drizzle `0063` + `0065` carry — a package is readable from its home and from the spaces it is shared into, never from the fact that somebody installed it — does not hide every pre-existing team installation at the first request; **run inside the window, right after `0014`**, whose `home_space_id` it reads                                                                                                                                                                         | unmeasured — prints the installations-outside-home count and the without-share count before, and the without-share count after, which must be 0. **Ran in the beta.58 window.** Read back 2026-09-18: 4 `package_shares` rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 0017 | 2026-09-17          | the 2 org members moved off `viewer` **by hand** on 2026-09-09 (to `member`, the only value available before drizzle `0056` added `guest`) given the shape `0008` writes for a real viewer: one `viewer` `space_members` row per TEAM space of their org, then `member` → `guest`. `0008` cannot see them — its `WHERE role::text = 'viewer'` is the empty set — while `member` + `spaces.default_role = 'operator'` is write access in every open space; **run inside the window, right after `0008` and `0012`**                                                                                                        | 2 pairs counted on production read-only 2026-09-17 (31 `owner` / 16 `admin` / **2 `member`** / 0 `viewer`), NOT rehearsed against a restored dump — prints the per-pair role before and after and aborts on any uncovered (user, team space) pair. **Ran in the beta.58 window**, right after `0008` and `0012`; the end-state witness is the one in `0008`'s row                                                                                                                                                                                                                                                                                                                                            |
| 0019 | not applied         | credentials of members removed before the leave-organization release: `api_keys` whose creator is no longer a member of the key's org, and opaque OAuth refresh/access tokens of the org's own clients or bound to its MCP resource URI (`<APP_URL>/api/mcp/o/<org_id>`) whose user is no longer a member — `revoked_at` / `revoked` set where NULL; **run once after deploying the release**, with `-v app_url=<APP_URL>`                                                                                                                                                                                                | unmeasured — prints the key / refresh / access counts before and aborts if any captured row is still unrevoked after. NOT rehearsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
