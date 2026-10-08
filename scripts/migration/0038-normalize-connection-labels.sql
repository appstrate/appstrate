-- 0038 — every connection label within what `connectionLabelProblem` and `CONNECTION_LABEL_MAX`
-- (`apps/api/src/lib/connection-label.ts`) accept (#1786; see the
-- `integration_connections_label_normalized` CHECK). Drizzle `0083` refuses the boot while a label
-- violates it, naming this file. A database that ran `0032` before `0077` holds none; one that
-- applied `0077` without it may keep provider identities stored raw before #1611, and `0032` can
-- no longer run there (it reads the `connection_id` columns `0077` drops).
--
-- Prerequisite: the database has `0077` (beta.65) — this file relies on its NOT NULL label and
-- unique index `idx_integration_conn_label`. psql or any client, PostgreSQL 16+ (the `0x…` integer
-- literals, `regexp_count`), a UTF8 database (the code points are read with `ascii()`; the file
-- refuses otherwise).
--
-- Pre-flight, read-only, on production or a restored dump — the CHECK `0083` adds:
--
--   SELECT count(*) AS labels_to_normalize FROM integration_connections WHERE NOT (label <> '' AND label !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$' AND label !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\U000E0000-\U000E007F]' AND char_length(label) + regexp_count(label, '[\U00010000-\U0010FFFF]') <= 80);
--
-- 0: nothing to run (production is expected at 0: it ran `0032`). Otherwise, before the deploy
-- and with the app container stopped (`docker stop`, not a Coolify stop): `pg_dump`, then
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migration/0038-normalize-connection-labels.sql
--
-- then deploy. If `0083` refuses the boot anyway (a label written after the pre-flight), stop the
-- app, run this file, redeploy. Rows: UNMEASURED — measured on the production database before the
-- release.
--
-- Only a label the CHECK refuses is rewritten; a label it accepts is never touched, so the
-- rewritten ones yield to it. In ONE transaction:
-- 1. NORMALIZE (as `0032`'s) — line breaks → space, the code points the rule forbids (C0/DEL/C1,
--    `isHiddenCodePoint`) dropped, both ends trimmed of what JS `trim()` strips, cut to 80 UTF-16
--    units and right-trimmed again. A label the rule accepts maps to itself, so "the mapping
--    changes it" is exactly "the CHECK refuses it".
-- 2. DEDUPE — within a (space, integration), a normalized label another row keeps, or that an
--    older (`created_at`, `id`) rewritten row also normalizes to, becomes "<base> (n)", n the
--    smallest ≥ 2 the group does not hold, `base` cut so the result stays ≤ 80 UTF-16 units.
-- 3. MINT — a label normalization empties becomes "Connexion N" past the group's highest
--    "Connexion <n>", as `0077` and the service mint it.
-- Every rewritten label is listed (connection, space, integration, before, after) so the owners
-- can be told. No final label equals another row's label, before or after, so the single UPDATE
-- never trips the unique index midway.
--
-- Idempotent: the rewrite set is the condition its write removes. Rollback: restore the `pg_dump`;
-- renamed labels are ordinary rows their owners edit.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION '0038: server_encoding is %, not UTF8 — NORMALIZE reads code points with ascii(). Nothing was written.',
      current_setting('server_encoding');
  END IF;
END $$;

-- ═══ 1. NORMALIZE ═══
--
-- `ascii()` is the code point (UTF8 database); `regexp_split_to_table(…, '')` splits by code
-- point. `ws` is what JS `trim()` strips that the mapping leaves: U+0020 and the other Zs space
-- separators. NULL: normalization empties it.
CREATE TEMP VIEW _0038_label_norm AS
SELECT c.id, c.space_id, c.integration_package_id, c.created_at, c.label, cut.label AS normalized
FROM integration_connections c
CROSS JOIN (SELECT U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000' AS ws) k
-- line break → space (`isLineOrTab`), forbidden → dropped (`isForbidden`), both ends trimmed
CROSS JOIN LATERAL (
  SELECT btrim(string_agg(
           CASE
             WHEN p.cp BETWEEN 0x09 AND 0x0D OR p.cp IN (0x85, 0x2028, 0x2029) THEN ' '
             WHEN p.cp <= 0x1F
               OR p.cp BETWEEN 0x7F AND 0x9F
               OR p.cp IN (0xAD, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180E, 0x3164, 0xFEFF, 0xFFA0)
               OR p.cp BETWEEN 0x200B AND 0x200F
               OR p.cp BETWEEN 0x202A AND 0x202E
               OR p.cp BETWEEN 0x2060 AND 0x206F
               OR p.cp BETWEEN 0xE0000 AND 0xE007F THEN ''
             ELSE s.ch
           END, '' ORDER BY s.i), k.ws) AS mapped
  FROM regexp_split_to_table(c.label, '') WITH ORDINALITY AS s(ch, i)
  CROSS JOIN LATERAL (SELECT ascii(s.ch) AS cp) p
) m
-- cut to 80 UTF-16 units, right-trimmed, '' → NULL
CROSS JOIN LATERAL (
  SELECT NULLIF(rtrim(string_agg(w.ch, '' ORDER BY w.i) FILTER (WHERE w.run <= 80), k.ws), '') AS label
  FROM (
    SELECT t.ch, t.i,
           sum(CASE WHEN ascii(t.ch) > 0xFFFF THEN 2 ELSE 1 END) OVER (ORDER BY t.i) AS run
    FROM regexp_split_to_table(m.mapped, '') WITH ORDINALITY AS t(ch, i)
  ) w
) cut;

SELECT count(*)                                  AS labels_to_normalize_before,
       count(*) FILTER (WHERE normalized IS NULL) AS labels_emptied_before
FROM _0038_label_norm
WHERE normalized IS DISTINCT FROM label;

-- ═══ 2. DEDUPE + 3. MINT — every final label, computed before any write ═══

CREATE TEMP TABLE _0038_label_rewrites ON COMMIT DROP AS
WITH todo AS (
  SELECT * FROM _0038_label_norm WHERE normalized IS DISTINCT FROM label
),
-- the labels no rewrite gives up
kept AS (
  SELECT c.space_id, c.integration_package_id, c.label
  FROM integration_connections c
  WHERE c.id NOT IN (SELECT id FROM todo)
),
grp AS (
  SELECT space_id, integration_package_id,
         count(*) AS size,
         -- room for the base: 80 minus the widest suffix, " (2·size+1)"
         80 - length(' (' || (2 * count(*) + 1)::text || ')') AS room
  FROM integration_connections
  GROUP BY space_id, integration_package_id
),
ranked AS (
  SELECT t.id, t.space_id, t.integration_package_id, t.created_at, t.normalized, g.size, g.room,
         row_number() OVER (
           PARTITION BY t.space_id, t.integration_package_id, t.normalized
           ORDER BY t.created_at, t.id) AS nth,
         EXISTS (SELECT 1 FROM kept k
                  WHERE k.space_id = t.space_id
                    AND k.integration_package_id = t.integration_package_id
                    AND k.label = t.normalized) AS held
  FROM todo t
  JOIN grp g USING (space_id, integration_package_id)
  WHERE t.normalized IS NOT NULL
),
plain AS (
  SELECT id, space_id, integration_package_id, normalized AS label
  FROM ranked
  WHERE nth = 1 AND NOT held
),
moved AS (
  SELECT r.id, r.space_id, r.integration_package_id, r.created_at, r.size,
         CASE WHEN w.width <= r.room THEN r.normalized ELSE rtrim(w.prefix, U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000') END AS base
  FROM ranked r
  -- UTF-16 width, as `CONNECTION_LABEL_MAX` counts it: the whole label's, and
  -- its longest prefix that fits the room
  CROSS JOIN LATERAL (
    SELECT max(ch.run) AS width,
           string_agg(ch.c, '' ORDER BY ch.i) FILTER (WHERE ch.run <= r.room) AS prefix
    FROM (
      SELECT t.c, t.i,
             sum(CASE WHEN ascii(t.c) > 65535 THEN 2 ELSE 1 END) OVER (ORDER BY t.i) AS run
      FROM regexp_split_to_table(r.normalized, '') WITH ORDINALITY AS t(c, i)
    ) ch
  ) w
  WHERE r.nth > 1 OR r.held
),
moved_ranked AS (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY m.space_id, m.integration_package_id, m.base
           ORDER BY m.created_at, m.id) AS k
  FROM moved m
),
-- "<base> (n)": neither kept nor a plain rewrite; two renames differ in base or in n
renamed AS (
  SELECT m.id, s.label
  FROM moved_ranked m
  CROSS JOIN LATERAL (
    SELECT m.base || ' (' || n || ')' AS label
    FROM generate_series(2, 2 * m.size + 1) AS n
    WHERE NOT EXISTS (
        SELECT 1 FROM kept k
        WHERE k.space_id = m.space_id
          AND k.integration_package_id = m.integration_package_id
          AND k.label = m.base || ' (' || n || ')')
      AND NOT EXISTS (
        SELECT 1 FROM plain p
        WHERE p.space_id = m.space_id
          AND p.integration_package_id = m.integration_package_id
          AND p.label = m.base || ' (' || n || ')')
    ORDER BY n
    OFFSET m.k - 1
    LIMIT 1) AS s
),
-- above every "Connexion <n>" kept or normalized; a rename ends in ")" and cannot be one
minted AS (
  SELECT t.id,
         'Connexion ' || (b.base + row_number() OVER (
           PARTITION BY t.space_id, t.integration_package_id
           ORDER BY t.created_at, t.id)) AS label
  FROM todo t
  CROSS JOIN LATERAL (
    SELECT coalesce(max(substring(x.label FROM '^Connexion ([0-9]+)$')::numeric), 0) AS base
    FROM (
      SELECT k.label FROM kept k
      WHERE k.space_id = t.space_id AND k.integration_package_id = t.integration_package_id
      UNION ALL
      SELECT p.label FROM plain p
      WHERE p.space_id = t.space_id AND p.integration_package_id = t.integration_package_id
    ) x
  ) b
  WHERE t.normalized IS NULL
)
SELECT id, label, 'normalized' AS step FROM plain
UNION ALL SELECT id, label, 'deduped' FROM renamed
UNION ALL SELECT id, label, 'minted' FROM minted;

SELECT count(*) FILTER (WHERE step = 'normalized') AS labels_normalized,
       count(*) FILTER (WHERE step = 'deduped')    AS labels_deduped,
       count(*) FILTER (WHERE step = 'minted')     AS labels_minted
FROM _0038_label_rewrites;

-- Every label rewritten: tell each connection's owner.
SELECT r.id AS connection_id, c.space_id, c.integration_package_id,
       c.label AS label_before, r.label AS label_after
FROM _0038_label_rewrites r
JOIN integration_connections c ON c.id = r.id
ORDER BY c.space_id, c.integration_package_id, c.created_at, c.id;

UPDATE integration_connections c
SET label = r.label,
    updated_at = now()
FROM _0038_label_rewrites r
WHERE c.id = r.id;

-- ═══ After — the CHECK `0083` adds, so a 0 here is `0083` applying ═══

SELECT count(*) AS labels_to_normalize_after FROM integration_connections WHERE NOT (label <> '' AND label !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$' AND label !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\U000E0000-\U000E007F]' AND char_length(label) + regexp_count(label, '[\U00010000-\U0010FFFF]') <= 80);

DO $$
DECLARE
  v_left bigint := (SELECT count(*) FROM integration_connections WHERE NOT (label <> '' AND label !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$' AND label !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\U000E0000-\U000E007F]' AND char_length(label) + regexp_count(label, '[\U00010000-\U0010FFFF]') <= 80));
BEGIN
  IF v_left > 0 THEN
    RAISE EXCEPTION '0038: % label(s) still outside the label rule — aborting', v_left;
  END IF;
END $$;

DROP VIEW _0038_label_norm;

COMMIT;
