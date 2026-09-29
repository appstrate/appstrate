-- 0032 — the row work the connection-sets release needs BEFORE its drizzle batch.
--
-- Run with the platform STOPPED: stop → `0033-unshare-space-access-loss.ts --apply` → run this
-- file → deploy the new image (`0077` applies at boot) → reopen. After `0033`, because the freeze
-- turns a colleague's shared connection into a member pin: a connection `0033` unshares (its owner
-- no longer reaches the space) is then no longer shared, so it is never frozen. Before the batch
-- because the freeze reads and writes the scalar `connection_id` columns `0077` folds and drops,
-- and the dedupe is the precondition of `0077`'s unique index `idx_integration_conn_label`.
-- Skipped on a database holding a duplicate label, `0077` fails (23505) and the batch rolls back;
-- with none, the batch lands and the other three sections are simply missing.
--
-- Four sections in ONE transaction; each prints a "before" count and an "after" count that must
-- read 0.
--
-- 1. SHAPE — the three snapshot columns hold SETS (a scalar becomes a one-element array; arrays
--    and `{}` are left alone). The readers accept only sets.
--      runs.connection_overrides              { id: "<uuid>" } → { id: ["<uuid>"] }
--      runs.resolved_connections              { id: {…} }      → { id: [{…}] }
--      package_schedules.connection_overrides { id: "<uuid>" } → { id: ["<uuid>"] }
--
-- 2. FREEZE — the old fallback bound a colleague's shared connection implicitly; the new one binds
--    only the actor's single OWN connection. Each such pick becomes the member pin the member
--    would have set (`user_id` = `created_by`, in the pre-`0077` scalar shape): one per (space,
--    agent, integration, user), from the latest qualifying run among the last 30 days and the
--    latest resolved run of each enabled schedule. A pick qualifies when the actor is a platform
--    user still in the organization and the agent a real package; the set is ONE `fallback_auto`
--    connection, still shared, healthy and owned by another current member; its auth is still
--    declared by the integration's draft manifest and not excluded by an `auth_key` in the agent's
--    draft or `latest` manifest; it is still the only healthy connection the user reaches there;
--    and no admin pin, member pin or reachable org default decides first. Approximations: only the
--    draft and `latest` agent manifests are read, and the serving-auth filter
--    (`servingCandidates`) is not reproduced — such a pin fails loudly, naming the row. End users
--    own no member pins: list their triples with the standalone query at the end, before the
--    window.
--
-- 3. NORMALIZE — every non-empty label becomes what `toMintedLabel`
--    (`apps/api/src/lib/connection-label.ts`) makes of it: line breaks → space, C0/DEL/C1 and
--    `isHiddenCodePoint` code points dropped, whitespace runs → one space, trimmed, cut to 80
--    UTF-16 units; emptied → NULL (`0077` backfills it). Runs before the dedupe, which must compare
--    what the index will.
--
-- 4. DEDUPE — within a (space, integration), every holder of a label after the oldest
--    (`created_at`, `id`) becomes "<base> (n)", n the smallest ≥ 2 the group does not hold, `base`
--    cut so the result stays ≤ 80 UTF-16 units. It cannot collide with a held label, another
--    rename, or a "Connexion N" `0077` mints. NULL and '' are left to `0077`'s backfill;
--    comparison is verbatim.
--
-- Idempotent: every WHERE is the condition its write removes. After the batch the file raises
-- (42703, the dropped `connection_id` columns) and rolls back.
--
-- Rows: NOT YET REHEARSED — rehearse on a restored dump and record every count here before the
-- window.
--
-- Rollback: none (collapsing a set is lossy); restore the pre-run `pg_dump`. Frozen pins and
-- renamed labels are ordinary rows their owners edit.

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

-- ═══ 2. FREEZE ═══
--
-- `connectionId` / `source` are the keys each snapshot element carries. Matched on `id::text`, so
-- a malformed value matches nothing instead of failing a `::uuid` cast. Materialized once: the
-- 30-day scan of `runs` is sequential.
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

-- ═══ 3. NORMALIZE ═══
--
-- A VIEW, so the "after" line re-evaluates the rewrite. `ascii()` is the code point (UTF-8
-- database); `regexp_split_to_table(…, '')` splits by code point.
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

-- ═══ 4. DEDUPE ═══

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

-- ═══ Standalone counts — read-only, before the window and after the fact ═══
--
-- The dedupe and shape counts (the freeze and the normalization are sized by their "before"
-- lines on the rehearsal dump). After the run every `_todo` reads 0; the `_total` controls tell
-- "nothing to rewrite" from "nothing at all".
--
--   SELECT count(*) AS duplicate_labels_todo FROM (
--     SELECT 1 FROM integration_connections
--     WHERE label IS NOT NULL AND label <> ''
--     GROUP BY space_id, integration_package_id, label
--     HAVING count(*) > 1) d;
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
-- Read-only, before the window: the (space, agent, integration) triples whose end-user runs of
-- the last 30 days the fallback bound to a shared connection the end-user does not own. After the
-- deploy they fail until the API caller passes `connection_overrides` or an admin pins one.
-- Reads either shape.
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
