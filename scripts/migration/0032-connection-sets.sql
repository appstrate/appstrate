-- 0032 — the row work the connection-sets release needs BEFORE its drizzle
-- batch: the three connection jsonb columns become SETS, departed members stop
-- sharing, the shared connections the old fallback picked implicitly become
-- member pins, labels lose the characters a label may not carry, and labels
-- become unique per (space, integration).
--
-- Run BEFORE the drizzle batch, with the platform STOPPED. The window is:
-- stop → run this file → deploy the new image (`0077` applies at boot) →
-- reopen.
--
-- WHY that moment and not after the batch. The freeze and both label sections
-- depend on it: the pin freeze reads `integration_org_defaults.connection_id`
-- and writes `integration_pins.connection_id`, the two scalar columns `0077`
-- folds into `connection_ids` and drops; the label dedupe is the precondition
-- of `0077`'s `CREATE UNIQUE INDEX "idx_integration_conn_label"`, which
-- `docs/NO_TRANSITIONAL_CODE.md` §2 does not license a repair beside; and the
-- normalization must precede that dedupe (it can make two labels equal) and
-- leaves the labels it empties to `0077`'s backfill. The shape rewrite depends
-- on nothing `0077` does — the columns are jsonb and neither their type nor
-- any constraint on them moves — but the new readers raise on the old shape
-- rather than degrade, so with the platform down no request ever meets an
-- unrewritten row. The old code never reads a rewritten row either: its image
-- is stopped the moment the rewrite starts.
--
-- A database that skipped this file and holds a duplicate label does NOT boot
-- half-migrated: `0077`'s unique index raises 23505 and the whole batch rolls
-- back, loudly. One holding no duplicate DOES boot, and misses four sections:
--   - the shape rewrite — its readers raise on the first old row;
--   - the departed-owner unshare — a SECURITY loss: a member who left the
--     organization before the deploy keeps every connection they shared usable
--     by the members who stayed, until a write on that space happens to run
--     the service's unshare;
--   - the freeze — members who leaned on a colleague's shared connection meet
--     `must_choose_connection`;
--   - the label normalization — a label carrying a line break, control,
--     invisible or bidi character keeps reaching the model verbatim, and a
--     whitespace-only one passes `0077`'s `label <> ''` CHECK.
--
-- (The `integration_connections.label` BACKFILL — NULL or '' → "Connexion N" —
-- is NOT here: it is the precondition of `0077`'s `SET NOT NULL` and `CHECK`,
-- which §2 does license, so it lives in `0077`.)
--
-- Sections, in order, in ONE transaction: 1. shape rewrite, 2. unshare
-- departed members, 3. freeze implicit shared picks, 4. label normalization,
-- 5. label dedupe. Three `UPDATE`s + one `UPDATE` + one `INSERT` + one
-- `UPDATE` + one `UPDATE`, no `DELETE`.
--
-- ═══ 1. SHAPE — the three snapshot columns hold SETS ═══
--
-- An integration now binds 1..N connections per run, so three snapshot columns
-- change SHAPE (not type — all three stay jsonb):
--
--   runs.connection_overrides              { id: "<uuid>" }   → { id: ["<uuid>"] }
--   runs.resolved_connections              { id: {…} }        → { id: [{…}] }
--   package_schedules.connection_overrides { id: "<uuid>" }   → { id: ["<uuid>"] }
--
-- The new readers expect an array and there is no scalar path left to fall
-- back to — that is the doctrine (`docs/NO_TRANSITIONAL_CODE.md`), and it is
-- what makes this section necessary rather than optional. A row left in the old
-- shape fails loudly at the next read; `runs.resolved_connections` in
-- particular is read long after kickoff by the live-credentials route, so a
-- finished-but-still-referenced run is not a safe thing to skip.
--
-- Values ALREADY an array are left untouched: the
-- `EXISTS (… jsonb_typeof(v) <> 'array')` guard is exactly the condition each
-- `UPDATE` removes. It also leaves `{}` alone — `jsonb_object_agg` over zero
-- pairs returns NULL, and an empty map must stay an empty map.
--
-- NOT rewritten, and nothing to do: the copy of
-- `package_schedules.connection_overrides` that each schedule's BullMQ job
-- carries in Redis. At boot the scheduler upserts the job of every enabled
-- schedule from its row — by then rewritten — BEFORE its worker starts, and
-- the upsert replaces the pending job with one built from the new data. A
-- job the sync skips (e.g. a schedule whose package is gone) still holds the
-- old shape; every fire validates the copy it reads and records a visible
-- failed run for it instead of launching (`apps/api/src/services/scheduler.ts`,
-- `initScheduleWorker` and `triggerScheduledRun`).
--
-- ═══ 2. UNSHARE — connections of owners who left the organization ═══
--
-- The release unshares a member's `shared_with_org` connections the moment they
-- lose access to the space (`unshareConnectionsOfOwnersWithoutAccess`,
-- `apps/api/src/services/space-members.ts`) — but only on writes made from now
-- on. A member who left the organization BEFORE the deploy still shares. This
-- section unshares every user-owned `shared_with_org = true` connection whose
-- owner is no longer in `org_members` for the organization of the connection's
-- space, the service's "no org membership" branch, with the same write
-- (`shared_with_org = false`, `updated_at = now()`). It runs before the freeze,
-- so the freeze neither pins such a connection nor counts it as reachable.
--
-- An admin pin or an org default still naming one of them then fails with
-- `pinned_connection_unavailable`, as it does after a live departure; the
-- "before" line prints how many pins and defaults name one, so the rehearsal
-- sizes that.
--
-- NOT covered: SPACE-level access loss before the deploy — an owner still in
-- the organization but removed from a closed space, or whose space closed,
-- keeps sharing there. That predicate is `resolveSpaceRole` (role presets,
-- custom space roles, visibility), which this file does not reproduce. It is
-- repaired the next time any write touching that member or that space runs the
-- service; until then, the old behaviour stands for those rows.
--
-- ═══ 3. FREEZE — implicit shared picks become member pins ═══
--
-- The resolver's last layer (the fallback, then layer 7, now layer 6 of
-- `apps/api/src/services/integration-connection-resolver.ts`) used to
-- auto-bind the actor's single healthy ACCESSIBLE connection — own OR another
-- member's `shared_with_org = true` one. It now auto-binds the actor's single
-- OWN connection only; a connection someone else shared is used after an
-- explicit choice (member pin, run/schedule override, org default), never
-- implicitly. A member whose runs silently leaned on a colleague's shared
-- connection would otherwise meet `must_choose_connection` on the first run
-- after the deploy.
--
-- So the pick the old fallback made for them is written down, as the member
-- pin they would have created had the picker asked. One pin per
-- (space, agent, integration, user), taken from the most recent qualifying run
-- among:
--
--   - every run of the last 30 days, and
--   - the latest run of each currently ENABLED schedule that recorded a
--     resolution (`resolved_connections IS NOT NULL`), WHATEVER ITS AGE — a
--     monthly, quarterly or yearly schedule leaning on a colleague's
--     connection would otherwise fail every fire after the deploy. A run that
--     failed before resolving records no pick, so it is skipped for the one
--     before it;
--
-- where ALL of the following hold:
--
--   - the run's actor is a platform user (`user_id` set, `end_user_id` NULL)
--     who is still a member of the space's organization, and its agent is a
--     real package (not deleted, not an inline shadow row);
--   - its resolved set for the integration is ONE connection whose source is
--     `fallback_auto`;
--   - that connection still exists in the run's space, on that integration,
--     is `shared_with_org = true`, is NOT owned by the user, is owned by a
--     platform user who is still a member of the space's organization (never
--     an end-user's, never a departed member's — section 2 has just unshared
--     the latter anyway), and is healthy (`needs_reconnection = false`);
--   - its auth still passes the two filters the resolver applies to every
--     candidate before any layer: the integration's current manifest
--     (`packages.draft_manifest`, what `fetchIntegrationManifest` reads)
--     still declares it, when that manifest declares auths at all; and
--     neither the agent's draft manifest nor its `latest` published one pins
--     (`integrations_configuration.<id>.auth_key`) another auth;
--   - the old fallback would STILL pick it today: it is the only healthy
--     connection the user can reach there — no other healthy shared one, and
--     no healthy one of the user's own (the new fallback binds that one by
--     itself, so no pin is needed);
--   - nothing above the fallback decides today: no admin pin, no member pin of
--     that user, no org default the user can reach — a new member pin would
--     override a soft org default, which the old resolver did not do.
--
-- The pin row is what `upsertMemberPin` (`integration-pins-service.ts`)
-- inserts: `user_id` = `created_by` = the member, both timestamps `now()`.
-- It is written in the PRE-PR shape (scalar `connection_id`), because this file
-- runs before the batch; `0077` then folds it into `connection_ids` with every
-- other pin.
--
-- The candidate set is MATERIALIZED once (`CREATE TEMP TABLE … ON COMMIT
-- DROP`): `runs` has no index leading with `started_at`, so the 30-day scan is
-- a sequential scan, and it is paid once, not three times. The "after" line
-- does not re-read that set blindly: it counts candidates for which no member
-- pin holding exactly that connection exists, so a candidate the `INSERT`
-- skipped reads non-zero.
--
-- NOT covered: end-users. They own no member pins (the resolver never reads
-- one for them), so there is nothing to freeze. An end-user run that leaned on
-- a shared connection fails after the deploy until its API caller passes
-- `connection_overrides` on the run, or an admin pins the connection for the
-- agent. List the affected (space, agent, integration) triples with the
-- standalone end-user listing at the end of this file, before the window, and
-- hand them to whoever owns those callers.
--
-- Why the auth test. A pin names ONE row; the resolver drops a row on a
-- retired auth, or on an auth other than the agent's `auth_key`, before any
-- layer reads it. Pinning such a row would turn the old `not_connected` (or
-- the old fallback's pick of another row on the right auth) into
-- `pinned_connection_unavailable`, naming a pin nobody set.
--
-- Approximations — what that test and the uniqueness test do NOT reproduce:
--   - the uniqueness test counts every healthy candidate of the integration,
--     including rows on an auth those filters drop. That can only SKIP a pin
--     the old fallback would have honoured;
--   - the agent manifest a run reads is the version it runs (`version_ref`:
--     draft, a dist-tag, an exact version or a range); only the draft and
--     `latest` are read here. A mismatch in either SKIPS the pin, even for a
--     schedule running another version that agrees with the row. The one
--     case that writes a pin the old code would not have used: a schedule or
--     caller pinned to a version whose `auth_key` names another auth than the
--     row's while neither the draft nor `latest` does (the version changed
--     since the run that recorded the pick). Its runs then fail
--     `pinned_connection_unavailable` when other rows sit on the required
--     auth — the old fallback would have picked among those — and
--     `auth_key_mismatch` otherwise, as before;
--   - the release also drops a candidate on an auth serving none of the
--     agent's selected tools (`servingCandidates`), a filter the old code did
--     not have. It reads tool definitions and the agent's effective selection,
--     so it is not reproduced: a frozen pin on such an auth fails
--     `auth_serves_no_selected_tool`, naming the row. Without the pin the run
--     fails too (`not_connected` or `must_choose_connection`): the old code
--     launched it on a connection that exposed none of its tools.
--
-- ═══ 4. NORMALIZE — a label carries no line break, control, invisible or bidi character ═══
--
-- A label reaches the model verbatim — it is a value of the `connection` enum
-- of the sidecar's tools — so `apps/api/src/lib/connection-label.ts` refuses
-- one carrying any of those. Until now nothing did: the `PATCH` checked only
-- the length, and labels minted from a provider identity were stored as the
-- provider sent them. So existing rows can carry any of them, and a
-- whitespace-only label passes `0077`'s `label <> ''` CHECK.
--
-- Every non-empty label is rewritten to what `toMintedLabel` (same file)
-- makes of it, class for class:
--   - a line break or tab — U+0009–U+000D, U+0085, U+2028, U+2029 — becomes
--     a space;
--   - every other forbidden code point is dropped: C0 (≤ U+001F), DEL and C1
--     (U+007F–U+009F), and `isHiddenCodePoint`
--     (`packages/mcp-transport/src/sanitize.ts`) — U+00AD, U+115F–U+1160,
--     U+17B4–U+17B5, U+180E, U+200B–U+200F, U+202A–U+202E, U+2060–U+206F,
--     U+3164, U+FEFF, U+FFA0, U+E0000–U+E007F;
--   - every run of JavaScript whitespace (`\s`: the space, U+00A0, U+1680,
--     U+2000–U+200A, U+202F, U+205F, U+3000, and the line breaks above)
--     becomes one space, and both ends are trimmed;
--   - the result is cut to 80 UTF-16 units (`CONNECTION_LABEL_MAX`) and
--     right-trimmed again.
-- A label that ends up empty becomes NULL, and `0077`'s backfill names it
-- "Connexion N" like any unlabelled row. '' is left as it is: that backfill
-- already names it.
--
-- It runs BEFORE the dedupe, which must compare the labels the index will:
-- two labels that differed only by an invisible character are one label here,
-- and the dedupe tells them apart. The rewrite is a pure function of the
-- label and its output is a fixed point of it, so a second run finds nothing.
--
-- ═══ 5. DEDUPE — labels unique per (space, integration) ═══
--
-- A label is how a tool call names its connection, so `0077` makes it unique
-- per (space, integration). Until now it was minted per (space, integration,
-- OWNER) and freely editable, so two rows of a group can share one. Every row
-- after the first (by `created_at`, `id`) of a group sharing a label becomes
-- "<base> (n)". `base` is the label itself, or — when the label would not leave
-- room for the suffix — its longest prefix that does, right-trimmed; the room
-- is `CONNECTION_LABEL_MAX` (80, `apps/api/src/lib/connection-label.ts`) minus
-- the widest suffix the group can take, " (2·size+1)", and it is counted the
-- way that constant is, in UTF-16 code units (a character above U+FFFF counts
-- two). Every renamed label is therefore ≤ 80.
--
-- The renamed rows of one (group, base) take, in (`created_at`, `id`) order,
-- the smallest n ≥ 2 whose "<base> (n)" no row of the group holds yet. That
-- cannot collide:
--   - with a label already held — excluded by construction;
--   - with another renamed label — "<b1> (n1)" = "<b2> (n2)" forces n1 = n2 (a
--     label ends with exactly one trailing "(digits)" we appended) and then
--     b1 = b2, and within one base every renamed row takes a different n;
--   - with a label `0077` mints later — those are "Connexion N" with N above
--     every "Connexion <n>" the group holds, and a renamed label ends in ")",
--     so it is never "Connexion <digits>".
-- [2, 2·size+1] always holds enough free n: at most `size` labels of the
-- group are excluded, and at most `size − 1` rows of it are renamed.
--
-- NULL and '' labels are SKIPPED, not deduplicated: `0077` backfills each with
-- its own "Connexion N" before the index, as argued above. Comparison is
-- verbatim — "Prod" and "prod" are two labels, as they are to the index.
--
-- ═══ Idempotency ═══
--
-- Re-running BEFORE the batch changes nothing: every `WHERE` is the condition
-- its write removes — no non-array value is left, no departed owner still
-- shares, every frozen candidate now has a member pin (which the "no member
-- pin" condition excludes, and `ON CONFLICT DO NOTHING` backs), every label is
-- its own normalization, and no group holds a label twice. AFTER the batch the file cannot half-apply: `0077`
-- drops both `connection_id` columns the freeze names, so it raises (42703)
-- and — under psql's `ON_ERROR_STOP` — the whole transaction rolls back.
--
-- Rows: NOT YET REHEARSED. Production holds rows in all three shape columns
-- (every run since the snapshot shipped carries `resolved_connections`), so
-- this is not a state no reachable database is in: rehearse against a restored
-- dump (README, "Writing one", requirement 4) and record every before/after
-- count here BEFORE the window. The "after" counts must all read 0. The pin
-- count is sized by that rehearsal too: its query reads the rewritten shape,
-- so it has no standalone pre-flight twin below.
--
-- ROLLBACK: none is offered, and none is wanted. Collapsing an array back to
-- its first element is lossy the moment a run has bound more than one
-- connection, and it would restore a shape no deployed reader accepts. Recover
-- from the pre-run `pg_dump` instead. The frozen pins are ordinary member pins:
-- a member drops one from the agent page like any pin they set themselves. An
-- unshared connection is re-shared by its owner, should they rejoin; a renamed
-- or normalized label is edited like any other (its old spelling is in the
-- dump, and is exactly what the new `PATCH` would refuse).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ═══ 1. SHAPE ═══

-- VERIFY (before) — rows still holding a non-array value
SELECT
  (SELECT count(*) FROM runs r
    WHERE r.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_overrides_before,
  (SELECT count(*) FROM runs r
    WHERE r.resolved_connections IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_resolved_before,
  (SELECT count(*) FROM package_schedules s
    WHERE s.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS schedules_overrides_before;

UPDATE runs
SET connection_overrides = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(connection_overrides) AS e(k, v)
)
WHERE connection_overrides IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(connection_overrides) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

UPDATE runs
SET resolved_connections = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(resolved_connections) AS e(k, v)
)
WHERE resolved_connections IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(resolved_connections) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

UPDATE package_schedules
SET connection_overrides = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(connection_overrides) AS e(k, v)
)
WHERE connection_overrides IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(connection_overrides) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

-- ═══ 2. UNSHARE ═══
--
-- The predicate is written three times (before, UPDATE, after) on purpose: the
-- after line must re-evaluate it, not trust the UPDATE's own row count.

SELECT
  (SELECT count(*) FROM integration_connections c
    WHERE c.shared_with_org = true
      AND c.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM spaces sp
        JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
        WHERE sp.id = c.space_id))                               AS departed_shared_before,
  -- admin pins and org defaults that name one: they fail with
  -- `pinned_connection_unavailable` once it is unshared
  (SELECT count(*) FROM (
     SELECT p.connection_id FROM integration_pins p WHERE p.user_id IS NULL
     UNION ALL
     SELECT d.connection_id FROM integration_org_defaults d
   ) named
   JOIN integration_connections c ON c.id = named.connection_id
   WHERE c.shared_with_org = true
     AND c.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM spaces sp
       JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
       WHERE sp.id = c.space_id))                                AS departed_shared_named_by_admin;

UPDATE integration_connections c
SET shared_with_org = false,
    updated_at = now()
WHERE c.shared_with_org = true
  AND c.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM spaces sp
    JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
    WHERE sp.id = c.space_id);

-- must print 0
SELECT count(*) AS departed_shared_after
FROM integration_connections c
WHERE c.shared_with_org = true
  AND c.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM spaces sp
    JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
    WHERE sp.id = c.space_id);

-- ═══ 3. FREEZE ═══
--
-- `connectionId` / `source` are the keys the pre-PR resolver wrote into each
-- element (`ResolvedConnection`, camelCase TS serialised as-is). The connection
-- is matched on `id::text`, so a malformed snapshot value simply matches
-- nothing instead of failing a `::uuid` cast. `ON COMMIT DROP`: an abort or a
-- commit leaves nothing behind.
CREATE TEMP TABLE _0032_implicit_shared_picks ON COMMIT DROP AS
WITH latest_scheduled AS (
  -- the latest run that recorded a resolution, per enabled schedule, any age
  SELECT latest.id
  FROM package_schedules s
  CROSS JOIN LATERAL (
    SELECT r.id FROM runs r
    WHERE r.schedule_id = s.id
      AND r.resolved_connections IS NOT NULL
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1) AS latest
  WHERE s.enabled = true
)
SELECT DISTINCT ON (r.space_id, r.package_id, e.integration_id, r.user_id)
       r.space_id,
       r.package_id,
       e.integration_id,
       r.user_id,
       c.id AS connection_id
FROM runs r
CROSS JOIN LATERAL jsonb_each(r.resolved_connections) AS e(integration_id, v)
JOIN packages agent
  ON agent.id = r.package_id
 AND agent.ephemeral = false
JOIN integration_connections c
  ON c.id::text = e.v -> 0 ->> 'connectionId'
 AND c.space_id = r.space_id
 AND c.integration_package_id = e.integration_id
WHERE (r.started_at >= now() - interval '30 days'
       OR r.id IN (SELECT id FROM latest_scheduled))
  -- platform user, not an end-user, still in the organization
  AND r.user_id IS NOT NULL
  AND r.end_user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM spaces sp
    JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = r.user_id
    WHERE sp.id = r.space_id)
  -- a single connection, picked by the fallback
  AND r.resolved_connections IS NOT NULL
  AND jsonb_typeof(e.v) = 'array'
  AND jsonb_array_length(e.v) = 1
  AND e.v -> 0 ->> 'source' = 'fallback_auto'
  -- still someone else's shared, healthy connection …
  AND c.shared_with_org = true
  AND c.user_id IS DISTINCT FROM r.user_id
  AND c.needs_reconnection = false
  -- … owned by a member of the organization, never an end-user or a departed one
  AND c.user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM spaces sp
    JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
    WHERE sp.id = c.space_id)
  -- its auth is one the integration's current manifest still declares (no
  -- constraint when it declares none) …
  AND NOT EXISTS (
    SELECT 1 FROM packages i
    WHERE i.id = e.integration_id
      AND jsonb_typeof(i.draft_manifest -> 'auths') = 'object'
      AND i.draft_manifest -> 'auths' <> '{}'::jsonb
      AND i.draft_manifest -> 'auths' -> c.auth_key IS NULL)
  -- … and not one the agent's draft or `latest` manifest rules out by pinning another
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT agent.draft_manifest AS m
      UNION ALL
      SELECT v.manifest
      FROM package_dist_tags t
      JOIN package_versions v ON v.id = t.version_id
      WHERE t.package_id = r.package_id AND t.tag = 'latest'
    ) am
    CROSS JOIN LATERAL (
      SELECT am.m -> 'integrations_configuration' -> e.integration_id -> 'auth_key' AS k) pinned
    WHERE jsonb_typeof(pinned.k) = 'string'
      AND pinned.k #>> '{}' <> c.auth_key)
  -- the old fallback would still pick it: no OTHER healthy connection the user
  -- can reach there — neither another shared one nor one of their own
  AND NOT EXISTS (
    SELECT 1 FROM integration_connections o
    WHERE o.space_id = r.space_id
      AND o.integration_package_id = e.integration_id
      AND o.id <> c.id
      AND o.needs_reconnection = false
      AND (o.shared_with_org = true OR o.user_id = r.user_id))
  -- no layer above the fallback decides: no admin pin, no member pin of theirs
  AND NOT EXISTS (
    SELECT 1 FROM integration_pins p
    WHERE p.space_id = r.space_id
      AND p.package_id = r.package_id
      AND p.integration_package_id = e.integration_id
      AND (p.user_id IS NULL OR p.user_id = r.user_id))
  -- … and no org default whose connection the user can reach
  AND NOT EXISTS (
    SELECT 1 FROM integration_org_defaults d
    JOIN integration_connections dc ON dc.id = d.connection_id
    WHERE d.space_id = r.space_id
      AND d.integration_package_id = e.integration_id
      AND dc.space_id = r.space_id
      AND dc.integration_package_id = e.integration_id
      AND (dc.shared_with_org = true OR dc.user_id = r.user_id))
ORDER BY r.space_id, r.package_id, e.integration_id, r.user_id, r.started_at DESC, r.id DESC;

SELECT count(*) AS implicit_shared_picks_before FROM _0032_implicit_shared_picks;

INSERT INTO integration_pins
  (space_id, package_id, integration_package_id, user_id, connection_id,
   created_by, created_at, updated_at)
SELECT space_id, package_id, integration_id, user_id, connection_id,
       user_id, now(), now()
FROM _0032_implicit_shared_picks
ON CONFLICT DO NOTHING;

-- must print 0: every candidate now has a member pin naming exactly its connection
SELECT count(*) AS implicit_shared_picks_unpinned_after
FROM _0032_implicit_shared_picks k
WHERE NOT EXISTS (
  SELECT 1 FROM integration_pins p
  WHERE p.space_id = k.space_id
    AND p.package_id = k.package_id
    AND p.integration_package_id = k.integration_id
    AND p.user_id = k.user_id
    AND p.connection_id = k.connection_id);

DROP TABLE _0032_implicit_shared_picks;

-- ═══ 4. NORMALIZE ═══
--
-- A VIEW, not a materialized set: the "after" line re-evaluates the rewrite
-- rather than trusting the `UPDATE`. `ascii()` is the code point (the database
-- is UTF-8), and `regexp_split_to_table(…, '')` splits by code point.
CREATE TEMP VIEW _0032_label_norm AS
SELECT c.id, c.label, cut.label AS normalized
FROM integration_connections c
-- line break → space, forbidden → dropped, other whitespace → space
CROSS JOIN LATERAL (
  SELECT string_agg(
           CASE
             WHEN p.cp BETWEEN 0x09 AND 0x0D OR p.cp IN (0x85, 0x2028, 0x2029) THEN ' '
             WHEN p.cp <= 0x1F
               OR p.cp BETWEEN 0x7F AND 0x9F
               OR p.cp IN (0xAD, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180E, 0x3164, 0xFEFF, 0xFFA0)
               OR p.cp BETWEEN 0x200B AND 0x200F
               OR p.cp BETWEEN 0x202A AND 0x202E
               OR p.cp BETWEEN 0x2060 AND 0x206F
               OR p.cp BETWEEN 0xE0000 AND 0xE007F THEN ''
             WHEN p.cp IN (0x20, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000)
               OR p.cp BETWEEN 0x2000 AND 0x200A THEN ' '
             ELSE s.ch
           END, '' ORDER BY s.i) AS mapped
  FROM regexp_split_to_table(c.label, '') WITH ORDINALITY AS s(ch, i)
  CROSS JOIN LATERAL (SELECT ascii(s.ch) AS cp) p
) m
-- runs of spaces → one, both ends trimmed, cut to 80 UTF-16 units, right-trimmed, '' → NULL
CROSS JOIN LATERAL (
  SELECT NULLIF(rtrim(string_agg(w.ch, '' ORDER BY w.i) FILTER (WHERE w.run <= 80), ' '), '') AS label
  FROM (
    SELECT t.ch, t.i,
           sum(CASE WHEN ascii(t.ch) > 0xFFFF THEN 2 ELSE 1 END) OVER (ORDER BY t.i) AS run
    FROM regexp_split_to_table(btrim(regexp_replace(m.mapped, ' {2,}', ' ', 'g'), ' '), '')
         WITH ORDINALITY AS t(ch, i)
  ) w
) cut
WHERE c.label IS NOT NULL AND c.label <> '';

SELECT count(*)                                  AS labels_to_normalize_before,
       count(*) FILTER (WHERE normalized IS NULL) AS labels_emptied_before
FROM _0032_label_norm
WHERE normalized IS DISTINCT FROM label;

UPDATE integration_connections c
SET label = v.normalized,
    updated_at = now()
FROM _0032_label_norm v
WHERE c.id = v.id
  AND v.normalized IS DISTINCT FROM v.label;

-- must print 0
SELECT count(*) AS labels_to_normalize_after
FROM _0032_label_norm
WHERE normalized IS DISTINCT FROM label;

DROP VIEW _0032_label_norm;

-- ═══ 5. DEDUPE ═══

-- groups holding a non-empty label more than once
SELECT count(*) AS duplicate_labels_before FROM (
  SELECT 1 FROM integration_connections
  WHERE label IS NOT NULL AND label <> ''
  GROUP BY space_id, integration_package_id, label
  HAVING count(*) > 1) dup;

CREATE TEMP TABLE _0032_label_renames ON COMMIT DROP AS
WITH grp AS (
  SELECT space_id, integration_package_id,
         count(*) AS size,
         -- room for the base: 80 minus the widest suffix, " (2·size+1)"
         80 - length(' (' || (2 * count(*) + 1)::text || ')') AS room
  FROM integration_connections
  GROUP BY space_id, integration_package_id
),
held AS (
  SELECT c.id, c.space_id, c.integration_package_id, c.label, c.created_at,
         g.size, g.room,
         row_number() OVER (
           PARTITION BY c.space_id, c.integration_package_id, c.label
           ORDER BY c.created_at, c.id) AS nth
  FROM integration_connections c
  JOIN grp g USING (space_id, integration_package_id)
  WHERE c.label IS NOT NULL AND c.label <> ''
),
moved AS (
  SELECT h.id, h.space_id, h.integration_package_id, h.created_at, h.size,
         CASE WHEN w.width <= h.room THEN h.label ELSE rtrim(w.prefix) END AS base
  FROM held h
  -- UTF-16 width, as `CONNECTION_LABEL_MAX` counts it: the whole label's, and
  -- its longest prefix that fits the room
  CROSS JOIN LATERAL (
    SELECT max(ch.run) AS width,
           string_agg(ch.c, '' ORDER BY ch.i) FILTER (WHERE ch.run <= h.room) AS prefix
    FROM (
      SELECT t.c, t.i,
             sum(CASE WHEN ascii(t.c) > 65535 THEN 2 ELSE 1 END) OVER (ORDER BY t.i) AS run
      FROM regexp_split_to_table(h.label, '') WITH ORDINALITY AS t(c, i)
    ) ch
  ) w
  WHERE h.nth > 1
),
ranked AS (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY m.space_id, m.integration_package_id, m.base
           ORDER BY m.created_at, m.id) AS k
  FROM moved m
)
SELECT r.id, s.label
FROM ranked r
CROSS JOIN LATERAL (
  SELECT r.base || ' (' || n || ')' AS label
  FROM generate_series(2, 2 * r.size + 1) AS n
  WHERE NOT EXISTS (
    SELECT 1 FROM integration_connections t
    WHERE t.space_id = r.space_id
      AND t.integration_package_id = r.integration_package_id
      AND t.label = r.base || ' (' || n || ')')
  ORDER BY n
  OFFSET r.k - 1
  LIMIT 1) AS s;

SELECT count(*) AS labels_renamed FROM _0032_label_renames;

UPDATE integration_connections c
SET label = r.label,
    updated_at = now()
FROM _0032_label_renames r
WHERE c.id = r.id;

DROP TABLE _0032_label_renames;

-- must print 0
SELECT count(*) AS duplicate_labels_after FROM (
  SELECT 1 FROM integration_connections
  WHERE label IS NOT NULL AND label <> ''
  GROUP BY space_id, integration_package_id, label
  HAVING count(*) > 1) dup;

-- ═══ VERIFY (after) — all three must print 0 ═══
SELECT
  (SELECT count(*) FROM runs r
    WHERE r.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_overrides_after,
  (SELECT count(*) FROM runs r
    WHERE r.resolved_connections IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_resolved_after,
  (SELECT count(*) FROM package_schedules s
    WHERE s.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS schedules_overrides_after;

COMMIT;

-- ═══ Standalone counts — run read-only, before the window and after the fact ═══
--
-- The shape, unshare and dedupe counts, outside any transaction (the freeze has
-- no twin: it reads the rewritten shape; nor has the normalization: its
-- expression is too long to keep in step twice — its "before" line, on the
-- rehearsal dump, is its sizing). Before the window they size the work;
-- after the run the five `_todo` counts must all read 0. A shape total of 0
-- BEFORE is not by itself proof the file is unnecessary — pair it with the
-- control below, which counts every row that HAS a value, so "nothing to
-- rewrite" and "nothing at all" read differently.
--
--   SELECT
--     (SELECT count(*) FROM integration_connections c
--       WHERE c.shared_with_org = true AND c.user_id IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM spaces sp
--                         JOIN org_members m ON m.org_id = sp.org_id AND m.user_id = c.user_id
--                         WHERE sp.id = c.space_id))              AS departed_shared_todo,
--     (SELECT count(*) FROM (
--        SELECT 1 FROM integration_connections
--        WHERE label IS NOT NULL AND label <> ''
--        GROUP BY space_id, integration_package_id, label
--        HAVING count(*) > 1) d)                                  AS duplicate_labels_todo;
--
--   SELECT
--     (SELECT count(*) FROM runs r
--       WHERE r.connection_overrides IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS runs_overrides_todo,
--     (SELECT count(*) FROM runs r
--       WHERE r.resolved_connections IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS runs_resolved_todo,
--     (SELECT count(*) FROM package_schedules s
--       WHERE s.connection_overrides IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS schedules_overrides_todo,
--     -- control: rows carrying a non-empty map at all
--     (SELECT count(*) FROM runs WHERE connection_overrides <> '{}'::jsonb)             AS runs_overrides_total,
--     (SELECT count(*) FROM runs WHERE resolved_connections <> '{}'::jsonb)             AS runs_resolved_total,
--     (SELECT count(*) FROM package_schedules WHERE connection_overrides <> '{}'::jsonb) AS schedules_overrides_total;
--
-- ═══ Standalone listing — end-user runs this file does NOT cover ═══
--
-- Read-only, before the window. The (space, agent, integration) triples whose
-- end-user runs of the last 30 days were bound by the fallback to a shared
-- connection the end-user does not own. After the deploy those runs fail until
-- the API caller passes `connection_overrides`, or an admin pins the
-- connection for the agent. Shape-agnostic on purpose: it reads the scalar
-- element before the window and the one-element array after it.
--
--   SELECT r.space_id, r.package_id, e.integration_id,
--          count(DISTINCT r.end_user_id) AS end_users,
--          max(r.started_at)             AS last_run
--   FROM runs r
--   CROSS JOIN LATERAL jsonb_each(r.resolved_connections) AS e(integration_id, v)
--   CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(e.v) WHEN 'array' THEN e.v -> 0 ELSE e.v END) AS s(pick)
--   JOIN integration_connections c
--     ON c.id::text = s.pick ->> 'connectionId'
--    AND c.space_id = r.space_id
--   WHERE r.started_at >= now() - interval '30 days'
--     AND r.end_user_id IS NOT NULL
--     AND s.pick ->> 'source' = 'fallback_auto'
--     AND c.shared_with_org = true
--     AND c.end_user_id IS DISTINCT FROM r.end_user_id
--   GROUP BY r.space_id, r.package_id, e.integration_id
--   ORDER BY last_run DESC;
