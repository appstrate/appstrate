-- 0020 — give every custom space role the reads its actions require
-- (issue #1513).
--
-- Run ONCE, BEFORE the image that refuses such roles is deployed.
--
-- ═══ WHAT IT REPAIRS ═══
--
-- From #1513 on, the platform refuses a custom space role (`space_roles` row)
-- holding a permission without the read it requires — `schedules:write`
-- without `schedules:read`. Rows stored before the rule may violate it, and
-- nothing tolerates them at read time: the first edit of such a role would be
-- refused for a permission its author never touched.
--
-- ═══ WHAT IT DOES ═══
--
-- For each offending row, appends the CANONICAL read of every gated permission
-- it holds unsatisfied, once, after its existing entries, and bumps
-- `updated_at`. It only WIDENS; the after-check aborts if a captured row lost
-- any entry it held.
--
-- Why before the enforcing image: a wider row is valid for the image running
-- today, while the reverse order opens a window in which editing an existing
-- role fails. The widening IS a grant: holders read, from this run on, what
-- their role already acts on — and a `space-members:change-role` delegate
-- lacking an added read can no longer grant that role (subset rule).
--
-- Deploy-order window: the OLD image can still write an offending role between
-- the apply and the enforcing deploy. Re-run the dry run after that deploy: it
-- must list 0 rows; a second apply (idempotent) fixes any it lists.
--
-- ═══ THE EMBEDDED SNAPSHOT — a dated copy, not a live read ═══
--
-- `gated` below is a copy, taken 2026-09-23, of the rule in
-- `apps/api/src/lib/permissions.ts` (its override table) applied to the
-- space-level resources with a read action in `CORE_RESOURCE_ACTIONS`
-- (`packages/core/src/permissions.ts`) and in the default `MODULES` set's
-- `permissionsContribution`s (`mcp`, `webhooks`, `chat`). SQL cannot read the
-- TypeScript; if either moves before this runs, re-derive the list.
--
-- The rule: `R:a` requires its override if one exists; else nothing when
-- `a = read`; else `R:read` when `R` has a read action; else nothing. One row
-- per GATED permission, `reads` = any one satisfies it, the first is the one
-- added:
--
--   reads                         gated permissions
--   space-members:read            remove change-role
--   agents:read                   write configure delete share
--   runs:read | runs:read-all     agents:run, runs:cancel, runs:delete
--   skills:read                   write delete share
--   mcp-servers:read              write delete share
--   files:read                    delete
--   schedules:read                write delete
--   persistence:read              delete
--   end-users:read                write delete
--   api-keys:read                 create revoke
--   integrations:read             write delete install uninstall configure share
--   mcp:read                      invoke
--   webhooks:read                 write delete
--   chat:read                     write
--
-- Need nothing: every `:read`, `runs:read-all`, `space-members:invite`,
-- `integrations:connect`, `integrations:disconnect`, and resources without a
-- read (`space-settings`, `credential-proxy`). Every string not listed — an
-- opt-in module's included — is left untouched.
--
-- ═══ DRY RUN BY DEFAULT ═══
--
-- Without `-v apply=on` the file runs everything — listing, update, after-check
-- — then ROLLS BACK. The listing (org_id, id, key, current permissions, reads
-- to add) comes from the same view the UPDATE reads, so the two cannot drift.
-- `ON_ERROR_STOP` is set in the file, so a failed after-check never commits.
--
--   # dry run (everything rolled back)
--   docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
--     -f - < scripts/migration/0020-space-roles-read-coherence.sql
--
--   # apply
--   docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
--     -v apply=on -f - < scripts/migration/0020-space-roles-read-coherence.sql
--
-- Idempotent without a marker: the predicate is the violation itself, so a
-- second run captures nothing. One transaction, fenced; one `UPDATE`, no
-- `INSERT`, no `DELETE`.
--
-- ROLLBACK: not mechanical — the row does not record which reads were added.
-- Restore `permissions` from the listing the apply printed (keep it) or from
-- the pre-run dump.
--
-- Rehearsed 2026-09-23 on an 8-role synthetic fixture — coherent
-- (`schedules:write`+`read`); runner shape (`agents:run`, `runs:read`,
-- `runs:cancel`, `integrations:connect`); supervisor (`runs:read-all`,
-- `runs:cancel`, `runs:delete`, `agents:run`); read-free/out-of-scope strings
-- (`space-members:invite`, `integrations:disconnect`, `space-settings:write`,
-- `ghost:write`, `agents:bogus`); `schedules:write` alone;
-- `agents:run`+`agents:write`; `runs:delete` alone;
-- `mcp:invoke`+`webhooks:write`+`chat:write`. Apply: 4 roles widened / 7 reads
-- added (`schedules:read`; `agents:read`+`runs:read`; `runs:read`;
-- `chat:read`+`mcp:read`+`webhooks:read`), the other 4 untouched; rerun: 0
-- rows. This version's SQL body ran in PGlite (psql meta-commands stripped);
-- the psql wrapper (dry-run default → ROLLBACK, invalid `apply` → ROLLBACK,
-- `ON_ERROR_STOP`) was exercised on postgres:16-alpine the same day on the
-- previous `gated` list. `gated` machine-checked equal to `readGrantsFor` over
-- core + default modules (33 rows).
--
-- Rows: UNMEASURED on production — NOT rehearsed on a production dump. Count on
-- production and rehearse on a restored dump before applying (README
-- requirement 4), and record the counts here.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ═══ 1. The violation, stated once ══════════════════════════════════════════
--
-- A row is in the view when it holds a gated permission and none of its
-- `reads`; `reads_to_add` carries each such permission's canonical read, once.

CREATE TEMP VIEW mig0020_missing_reads AS
  WITH gated (permission, reads) AS (
    VALUES
      ('space-members:remove',      ARRAY['space-members:read']),
      ('space-members:change-role', ARRAY['space-members:read']),
      ('agents:write',              ARRAY['agents:read']),
      ('agents:configure',          ARRAY['agents:read']),
      ('agents:delete',             ARRAY['agents:read']),
      ('agents:share',              ARRAY['agents:read']),
      ('agents:run',                ARRAY['runs:read', 'runs:read-all']),
      ('skills:write',              ARRAY['skills:read']),
      ('skills:delete',             ARRAY['skills:read']),
      ('skills:share',              ARRAY['skills:read']),
      ('mcp-servers:write',         ARRAY['mcp-servers:read']),
      ('mcp-servers:delete',        ARRAY['mcp-servers:read']),
      ('mcp-servers:share',         ARRAY['mcp-servers:read']),
      ('runs:cancel',               ARRAY['runs:read', 'runs:read-all']),
      ('runs:delete',               ARRAY['runs:read', 'runs:read-all']),
      ('files:delete',              ARRAY['files:read']),
      ('schedules:write',           ARRAY['schedules:read']),
      ('schedules:delete',          ARRAY['schedules:read']),
      ('persistence:delete',        ARRAY['persistence:read']),
      ('end-users:write',           ARRAY['end-users:read']),
      ('end-users:delete',          ARRAY['end-users:read']),
      ('api-keys:create',           ARRAY['api-keys:read']),
      ('api-keys:revoke',           ARRAY['api-keys:read']),
      ('integrations:write',        ARRAY['integrations:read']),
      ('integrations:delete',       ARRAY['integrations:read']),
      ('integrations:install',      ARRAY['integrations:read']),
      ('integrations:uninstall',    ARRAY['integrations:read']),
      ('integrations:configure',    ARRAY['integrations:read']),
      ('integrations:share',        ARRAY['integrations:read']),
      ('mcp:invoke',                ARRAY['mcp:read']),
      ('webhooks:write',            ARRAY['webhooks:read']),
      ('webhooks:delete',           ARRAY['webhooks:read']),
      ('chat:write',                ARRAY['chat:read'])
  )
  SELECT r.org_id, r.id, r.key, r.permissions,
         array_agg(DISTINCT g.reads[1] ORDER BY g.reads[1]) AS reads_to_add
  FROM space_roles r
  JOIN gated g ON g.permission = ANY (r.permissions)
  WHERE NOT (g.reads && r.permissions)
  GROUP BY r.org_id, r.id, r.key, r.permissions;

-- The capture the after-check measures itself against: "0 left" is also what
-- an empty capture prints, so the check also proves every captured row got its
-- reads AND kept every entry it held.
CREATE TEMP TABLE mig0020_capture ON COMMIT DROP AS
  SELECT * FROM mig0020_missing_reads;

-- ═══ 2. Before — the dry-run listing ════════════════════════════════════════

SELECT org_id, id, key, permissions, reads_to_add
FROM mig0020_capture
ORDER BY org_id, key;

DO $$
BEGIN
  RAISE NOTICE 'before: % custom space role(s) act on a resource they do not read, in % organization(s); % read(s) to add',
    (SELECT count(*) FROM mig0020_capture),
    (SELECT count(DISTINCT org_id) FROM mig0020_capture),
    (SELECT coalesce(sum(cardinality(reads_to_add)), 0) FROM mig0020_capture);
END $$;

-- ═══ 3. Widen ═══════════════════════════════════════════════════════════════

UPDATE space_roles r
SET permissions = r.permissions || m.reads_to_add,
    updated_at = now()
FROM mig0020_missing_reads m
WHERE r.id = m.id;

-- ═══ 4. After — re-derived from the table, and it must DISCRIMINATE ═════════

DO $$
DECLARE
  v_left      bigint;
  v_captured  bigint;
  v_not_fixed bigint;
BEGIN
  SELECT count(*) INTO v_left FROM mig0020_missing_reads;
  SELECT count(*) INTO v_captured FROM mig0020_capture;
  -- A captured row that no longer holds its old entries plus its new reads —
  -- including one deleted meanwhile, which the join no longer finds.
  SELECT count(*) INTO v_not_fixed
    FROM mig0020_capture c
    LEFT JOIN space_roles r ON r.id = c.id
    WHERE r.id IS NULL
       OR NOT (r.permissions @> c.permissions AND r.permissions @> c.reads_to_add);
  RAISE NOTICE 'after: % of % captured role(s) widened, % role(s) still acting without reading',
    v_captured - v_not_fixed, v_captured, v_left;
  IF v_left > 0 OR v_not_fixed > 0 THEN
    RAISE EXCEPTION '% role(s) still violate the rule, % captured role(s) not widened as listed — aborting',
      v_left, v_not_fixed;
  END IF;
END $$;

-- Temp views are not ON COMMIT DROP; drop it so the session ends clean.
DROP VIEW mig0020_missing_reads;

-- ═══ 5. Commit only when asked ══════════════════════════════════════════════

\if :{?apply}
\else
\set apply off
\endif
\if :apply
COMMIT;
\echo '0020: APPLIED — committed.'
\else
ROLLBACK;
\echo '0020: DRY RUN — rolled back, nothing written. Re-run with -v apply=on to commit.'
\endif
